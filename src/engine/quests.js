// Quest Engine — generates research quests from brain gaps and patterns
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { broadcast } from './discussion.js';

// Analyze brain for gaps, weak connections, unexplored entities
function analyzeBrainGaps() {
  // Entities mentioned but with few connections (underexplored)
  const underconnected = db.prepare(`
    SELECT e.id, e.name, e.type, e.mention_count,
      (SELECT COUNT(*) FROM brain_connections WHERE entity_a = e.id OR entity_b = e.id) as conn_count
    FROM brain_entities e
    WHERE e.mention_count >= 3
    ORDER BY e.mention_count DESC
    LIMIT 30
  `).all().filter(e => e.conn_count < 3);

  // Hot topics that might need deeper research
  const hotTopics = db.prepare('SELECT * FROM brain_topics ORDER BY heat DESC LIMIT 8').all();

  // Weak connections that could be strengthened
  const weakConns = db.prepare(`
    SELECT bc.*, ea.name as from_name, ea.type as from_type, eb.name as to_name, eb.type as to_type
    FROM brain_connections bc
    JOIN brain_entities ea ON bc.entity_a = ea.id
    JOIN brain_entities eb ON bc.entity_b = eb.id
    WHERE bc.strength = 1
    ORDER BY RANDOM() LIMIT 10
  `).all();

  // Strong connections — potential for deeper investigation
  const strongConns = db.prepare(`
    SELECT bc.*, ea.name as from_name, ea.type as from_type, eb.name as to_name, eb.type as to_type
    FROM brain_connections bc
    JOIN brain_entities ea ON bc.entity_a = ea.id
    JOIN brain_entities eb ON bc.entity_b = eb.id
    ORDER BY bc.strength DESC LIMIT 10
  `).all();

  // Entity types distribution — find what's missing
  const typeCounts = db.prepare(`
    SELECT type, COUNT(*) as count FROM brain_entities GROUP BY type ORDER BY count DESC
  `).all();

  // Recent news that hasn't been brain-processed yet
  const unprocessedCount = db.prepare(`
    SELECT COUNT(*) as c FROM news_items 
    WHERE id NOT IN (SELECT DISTINCT news_id FROM brain_news_entities)
  `).get()?.c || 0;

  return { underconnected, hotTopics, weakConns, strongConns, typeCounts, unprocessedCount };
}

// Generate quests focused on research, discovery, and brain enrichment
export async function generateQuestsFromBrain() {
  const gaps = analyzeBrainGaps();
  
  if (!gaps.hotTopics.length && !gaps.underconnected.length) return [];

  // Existing quests to avoid duplicates
  const existing = db.prepare("SELECT title FROM quests WHERE status IN ('proposed','active') LIMIT 20").all();
  const existingTitles = existing.map(q => q.title).join('\n');

  const context = `BRAIN ANALYSIS:

UNDEREXPLORED ENTITIES (mentioned often but few connections):
${gaps.underconnected.slice(0, 8).map(e => `- ${e.name} (${e.type}, ${e.mention_count} mentions, only ${e.conn_count} connections)`).join('\n') || '(none)'}

HOT TOPICS:
${gaps.hotTopics.map(t => `- ${t.name} (heat: ${t.heat})`).join('\n') || '(none)'}

WEAK CONNECTIONS (need verification/strengthening):
${gaps.weakConns.map(c => `- ${c.from_name} → ${c.relation} → ${c.to_name}`).join('\n') || '(none)'}

STRONG PATTERNS (worth deeper investigation):
${gaps.strongConns.slice(0, 5).map(c => `- ${c.from_name} (${c.from_type}) ↔ ${c.to_name} (${c.to_type}) [${c.relation}, strength: ${c.strength}]`).join('\n') || '(none)'}

ENTITY TYPE DISTRIBUTION:
${gaps.typeCounts.map(t => `- ${t.type}: ${t.count}`).join('\n')}

UNPROCESSED NEWS ITEMS: ${gaps.unprocessedCount}

EXISTING ACTIVE QUESTS (avoid duplicates):
${existingTitles || '(none)'}`;

  const result = await callKimi(
    `You are the OpenGuild Brain Curator. Create 2 focused research quests to grow the knowledge graph.

Each quest MUST have:
- A specific, measurable GOAL (so it's clear when it's done)
- An OUTPUT specification: a structured .md file with sections for the brain to ingest
- A clear SCOPE — what entities/connections to research

Quest types:
1. RESEARCH — investigate an underexplored entity, produce a profile
2. CONNECT — find hidden links between entities, produce a connection map
3. DEEPEN — analyze a strong pattern, produce an analysis report

Format (strict, no markdown):
QUEST: <specific title>
TYPE: <research|connect|deepen>
GOAL: <one sentence: what exactly must be discovered/proven/mapped>
OUTPUT: <what the .md file must contain — sections, data points, connections>
DESCRIPTION: <2-3 sentences context>
PRIORITY: <low|normal|high|urgent>
---`,
    context,
    { maxTokens: 700, temperature: 0.75 }
  );

  if (!result?.text) return [];

  const quests = [];
  const blocks = result.text.split('---').filter(b => b.trim());

  for (const block of blocks) {
    const title = block.match(/QUEST:\s*(.+)/i)?.[1]?.trim();
    const type = block.match(/TYPE:\s*(\S+)/i)?.[1]?.trim()?.toLowerCase() || 'research';
    const goal = block.match(/GOAL:\s*(.+)/i)?.[1]?.trim() || '';
    const output = block.match(/OUTPUT:\s*(.+)/i)?.[1]?.trim() || '';
    const desc = block.match(/DESCRIPTION:\s*(.+)/is)?.[1]?.trim() || '';
    const priority = block.match(/PRIORITY:\s*(\w+)/i)?.[1]?.trim()?.toLowerCase() || 'normal';

    if (title && !existingTitles.includes(title)) {
      const fullDesc = `[${type}] ${desc}\n\nGOAL: ${goal}\n\nOUTPUT: ${output}`;
      const info = db.prepare(
        'INSERT INTO quests (title, description, priority, proposed_by, source, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        title, fullDesc,
        ['low','normal','high','urgent'].includes(priority) ? priority : 'normal',
        'Brain', 'brain', 'proposed'
      );

      quests.push({ id: info.lastInsertRowid, title, description: fullDesc, type, goal, output, priority, proposed_by: 'Brain', status: 'proposed' });
      console.log(`[Quests] Brain proposed: "${title}" (${type})`);
    }
  }

  return quests;
}

// Called during guild chat to propose a quest from discussion
export function proposeQuestFromChat(agentName, title, description) {
  const info = db.prepare(
    'INSERT INTO quests (title, description, proposed_by, source, status) VALUES (?, ?, ?, ?, ?)'
  ).run(title, description || '', agentName, 'guild-chat', 'proposed');

  const quest = {
    id: info.lastInsertRowid, title, description,
    proposed_by: agentName, status: 'proposed',
    votes_for: 0, votes_against: 0
  };

  broadcast('quest-proposed', quest);
  return quest;
}

// Vote on a quest
export function voteOnQuest(questId, vote) {
  if (vote === 'for') {
    db.prepare('UPDATE quests SET votes_for = votes_for + 1 WHERE id = ?').run(questId);
  } else {
    db.prepare('UPDATE quests SET votes_against = votes_against + 1 WHERE id = ?').run(questId);
  }

  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);
  if (quest && quest.status === 'proposed' && quest.votes_for >= 3 && quest.votes_for > quest.votes_against) {
    db.prepare("UPDATE quests SET status = 'active' WHERE id = ?").run(questId);
    broadcast('quest-activated', quest);
  }
  return quest;
}

// Get proposed quests for guild voting
export function getProposedQuests() {
  return db.prepare("SELECT * FROM quests WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 5").all();
}

// ══════════════════════════════════
// WORLD HISTORY QUEST GENERATOR
// ══════════════════════════════════
// Systematically explores world history — events, eras, connections, causes, consequences

const HISTORY_DOMAINS = [
  // Eras
  'Ancient civilizations (Mesopotamia, Egypt, Indus, China)',
  'Classical antiquity (Greece, Rome, Persia, Han Dynasty)',
  'Medieval period (Byzantium, Islamic Golden Age, Feudal Europe, Mongol Empire)',
  'Renaissance and Early Modern (1400-1700)',
  'Age of Exploration and Colonialism',
  'Industrial Revolution and 19th century transformations',
  'World War I — causes, events, consequences',
  'Interwar period — rise of fascism, communism, Great Depression',
  'World War II — all theaters, Holocaust, atomic age',
  'Cold War — proxy wars, space race, nuclear standoff',
  'Decolonization of Africa and Asia',
  'Late 20th century — fall of USSR, globalization, digital revolution',
  '21st century geopolitics — War on Terror, Arab Spring, rise of China',
  // Thematic
  'History of democracy and political revolutions',
  'History of science and technology breakthroughs',
  'History of trade routes (Silk Road, spice trade, Atlantic trade)',
  'History of religions and their spread',
  'History of pandemics and their impact on civilization',
  'History of art movements and cultural exchange',
  'History of warfare and military strategy evolution',
  'History of economic systems (feudalism → capitalism → globalization)',
  'History of espionage and intelligence agencies',
  'History of human rights movements',
  'History of space exploration',
  'History of philosophy — from Socrates to modern thought',
  // Connections & Patterns
  'How the fall of Rome shaped modern Europe',
  'How the Mongol Empire connected East and West',
  'How World War I caused World War II',
  'How colonialism shapes current geopolitical conflicts',
  'How the Cold War legacy affects today\'s world order',
  'How the printing press changed civilization (parallel to internet)',
  'How trade routes determined the rise and fall of empires',
  'How climate events shaped history (Little Ice Age, droughts, floods)',
];

export async function generateWorldHistoryQuest() {
  // Check what we've already researched
  const existingTitles = db.prepare(
    "SELECT title FROM quests WHERE source = 'world-history' ORDER BY created_at DESC LIMIT 50"
  ).all().map(q => q.title);

  // Check what entities we already have in the brain
  const brainEntities = db.prepare(
    "SELECT name, type FROM brain_entities WHERE type IN ('person','event','concept','country','org') ORDER BY mention_count DESC LIMIT 50"
  ).all();
  const brainContext = brainEntities.map(e => `${e.name} (${e.type})`).join(', ');

  // Pick a random domain that hasn't been covered much
  const shuffled = HISTORY_DOMAINS.sort(() => Math.random() - 0.5);
  const domain = shuffled[0];

  const result = await callKimi(
    `You are the OpenGuild History Curator. Generate 1 focused world history research quest.

DOMAIN: ${domain}

ENTITIES ALREADY IN BRAIN (avoid duplicating what we know):
${brainContext || 'none yet'}

PREVIOUS HISTORY QUESTS (avoid duplicates):
${existingTitles.slice(0, 15).join('\n') || 'none yet'}

Create a quest that:
1. Researches a SPECIFIC historical event, person, era, or connection
2. Discovers entities (people, events, places, concepts) for the knowledge graph
3. Maps connections between historical events and modern-day entities already in the brain
4. Produces verifiable facts with dates and sources

Format (strict):
QUEST: <specific title — not generic, name specific events/people/dates>
GOAL: <what exactly must be discovered and connected>
OUTPUT: <what the .md file must contain>
DESCRIPTION: <2-3 sentences context — why this matters for understanding the world>
PRIORITY: normal`,
    '', { maxTokens: 250, temperature: 0.85 }
  );

  if (!result?.text) return null;

  const title = result.text.match(/QUEST:\s*(.+)/i)?.[1]?.trim();
  const goal = result.text.match(/GOAL:\s*(.+)/i)?.[1]?.trim() || '';
  const output = result.text.match(/OUTPUT:\s*(.+)/i)?.[1]?.trim() || '';
  const desc = result.text.match(/DESCRIPTION:\s*(.+)/is)?.[1]?.trim() || '';
  const priority = result.text.match(/PRIORITY:\s*(\w+)/i)?.[1]?.trim() || 'normal';

  if (!title || existingTitles.includes(title)) return null;

  const fullDesc = `[world-history] ${desc}\n\nGOAL: ${goal}\n\nOUTPUT: ${output}`;

  const info = db.prepare(
    'INSERT INTO quests (title, description, priority, proposed_by, source, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, fullDesc, priority, 'History Curator', 'world-history', 'proposed');

  const quest = { id: info.lastInsertRowid, title, description: fullDesc, priority, proposed_by: 'History Curator', source: 'world-history', status: 'proposed' };

  console.log(`[Quests] World History quest: "${title}"`);
  broadcast('quest-proposed', quest);

  return quest;
}
