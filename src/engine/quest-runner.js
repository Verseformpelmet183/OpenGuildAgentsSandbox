// Quest Runner — multi-agent collaborative research with visible tool usage
// Rules:
// 1. Minimum 2 agents per quest — no solo quests
// 2. All agents research in parallel, all contribute to final .md
// 3. Every tool/skill call is posted in guild chat with results
// 4. Output .md + brain ingestion announced in chat

import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { getGuildAgents, getActiveAgents } from './agent-state.js';
import { broadcast } from './discussion.js';
import { ingestQuestOutput } from './brain.js';
import { webSearch, fetchPage, fetchWikipedia, verifyFact } from './tools.js';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const QUEST_DIR = join(process.cwd(), 'src/data/quests');
if (!existsSync(QUEST_DIR)) mkdirSync(QUEST_DIR, { recursive: true });

let isRunning = false;

function getArchetype(id) {
  return archetypes.find(a => a.id === id);
}

// Post a guild message with optional tool_data attachment
function postGuildMsg(agentId, content, toolData = null) {
  const arch = getArchetype(agentId);
  const toolDataStr = toolData ? JSON.stringify(toolData) : null;
  const info = db.prepare(
    'INSERT INTO guild_messages (agent_id, content, tokens_in, tokens_out, tool_data) VALUES (?, ?, 0, 0, ?)'
  ).run(agentId, content, toolDataStr);

  broadcast('guild-chat', {
    id: info.lastInsertRowid, agent_id: agentId, content,
    agent_name: arch?.name || agentId, agent_title: arch?.title || '',
    agent_color: arch?.color || '#888', agent_avatar: arch?.avatar || '?',
    tokens_in: 0, tokens_out: 0, tool_data: toolData,
    created_at: new Date().toISOString(), is_user: false
  });
}

// Get at least 2 agents for a quest
function getQuestTeam() {
  // Prefer guild agents, fall back to active
  let agents = getGuildAgents();
  if (agents.length < 2) {
    const active = getActiveAgents().filter(a => !agents.find(g => g.agent_id === a.agent_id));
    agents = [...agents, ...active];
  }
  // Shuffle and take 2-4
  agents = agents.sort(() => Math.random() - 0.5);
  return agents.slice(0, Math.min(4, Math.max(2, agents.length)));
}

// Main quest execution — collaborative multi-agent research
export async function executeQuest(questId) {
  if (isRunning) return;
  isRunning = true;

  const quest = db.prepare('SELECT * FROM quests WHERE id = ?').get(questId);
  if (!quest || quest.status === 'completed') { isRunning = false; return; }

  // Get team — MUST have at least 2 agents
  const team = getQuestTeam();
  if (team.length < 2) {
    console.log('[QuestRunner] Not enough agents for quest (need 2+)');
    isRunning = false;
    return;
  }

  // Mark as active
  db.prepare("UPDATE quests SET status = 'active' WHERE id = ?").run(questId);

  const teamArchs = team.map(a => ({ ...a, arch: getArchetype(a.agent_id) })).filter(t => t.arch);
  const teamNames = teamArchs.map(t => t.arch.name).join(', ');

  console.log(`[QuestRunner] Starting: "${quest.title}" with team: ${teamNames}`);

  try {
    // ══════════════════════════════════════════
    // PHASE 1: Team assembles, announces quest
    // ══════════════════════════════════════════
    const leader = teamArchs[0];
    postGuildMsg(leader.agent_id, `📋 New quest: "${quest.title}". Team: ${teamNames}. Let's divide the research.`);
    await sleep(2000);

    // ══════════════════════════════════════════
    // PHASE 2: Each agent plans their research angle
    // ══════════════════════════════════════════
    const agentPlans = [];
    for (const member of teamArchs) {
      const otherAngles = agentPlans.map(p => p.queries.join(', ')).join('; ');
      const planResult = await callKimi(
        `You are ${member.arch.name} (${member.arch.title}). ${member.arch.personality}

Quest: "${quest.title}"
${quest.description}
${otherAngles ? `\nOther team members are already researching: ${otherAngles}\nChoose DIFFERENT angles.` : ''}

Plan your unique research approach. Output EXACTLY:
SEARCH: query 1
SEARCH: query 2
SEARCH: query 3
WIKI: wikipedia topic
FACTCHECK: specific claim to verify`,
        '', { maxTokens: 150, temperature: 0.75 }
      );

      const planText = planResult?.text || '';
      const queries = (planText.match(/SEARCH:\s*(.+)/gi) || []).map(s => s.replace(/^SEARCH:\s*/i, '').trim()).filter(Boolean).slice(0, 3);
      const wiki = (planText.match(/WIKI:\s*(.+)/gi) || []).map(s => s.replace(/^WIKI:\s*/i, '').trim()).filter(Boolean).slice(0, 1);
      const factCheck = (planText.match(/FACTCHECK:\s*(.+)/gi) || []).map(s => s.replace(/^FACTCHECK:\s*/i, '').trim()).filter(Boolean).slice(0, 1);

      if (!queries.length) queries.push(quest.title + ' ' + member.arch.name);
      agentPlans.push({ member, queries, wiki, factCheck, findings: [], sources: [] });

      postGuildMsg(member.agent_id, `📝 My research plan: ${queries.map(q => `"${q}"`).join(', ')}${wiki.length ? ` + Wikipedia: ${wiki[0]}` : ''}${factCheck.length ? ` + Fact-check: "${factCheck[0].slice(0, 50)}..."` : ''}`, {
        tool: 'Research Plan',
        queries: queries,
        sources: wiki.map(w => ({ title: `Wikipedia: ${w}`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(w.replace(/ /g, '_'))}` }))
      });
      await sleep(1500);
    }

    // ══════════════════════════════════════════
    // PHASE 3: Parallel research — each agent searches independently
    // ══════════════════════════════════════════
    const allSources = new Set(); // dedup URLs

    for (const plan of agentPlans) {
      const { member, queries, wiki, factCheck } = plan;

      // Web searches
      for (const query of queries) {
        postGuildMsg(member.agent_id, `🔍 Searching: "${query}"`);
        const results = await webSearch(query);
        const foundSources = [];

        for (const r of results.slice(0, 2)) {
          if (allSources.has(r.url)) continue;
          allSources.add(r.url);
          const content = await fetchPage(r.url);
          if (content.length > 200) {
            plan.findings.push({ title: r.title, url: r.url, content: content.slice(0, 3000), type: 'web' });
            plan.sources.push({ title: r.title, url: r.url });
            foundSources.push({ title: r.title, url: r.url });
          }
        }

        if (foundSources.length) {
          postGuildMsg(member.agent_id, `📎 Found ${foundSources.length} sources for "${query.slice(0, 40)}..."`, {
            tool: 'Web Search',
            queries: [query],
            sources: foundSources
          });
        }
        await sleep(800);
      }

      // Wikipedia deep dive
      for (const topic of wiki) {
        postGuildMsg(member.agent_id, `📚 Reading Wikipedia: "${topic}"`);
        const wikiContent = await fetchWikipedia(topic);
        if (wikiContent.length > 200) {
          const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g, '_'))}`;
          plan.findings.push({ title: `Wikipedia: ${topic}`, url: wikiUrl, content: wikiContent.slice(0, 4000), type: 'wiki' });
          plan.sources.push({ title: `Wikipedia: ${topic}`, url: wikiUrl });
          postGuildMsg(member.agent_id, `📚 Got ${wikiContent.length} chars from Wikipedia: "${topic}"`, {
            tool: 'Wikipedia',
            sources: [{ title: `Wikipedia: ${topic}`, url: wikiUrl }]
          });
        }
        await sleep(500);
      }

      // Fact-checking
      for (const claim of factCheck) {
        postGuildMsg(member.agent_id, `🔎 Fact-checking: "${claim.slice(0, 60)}..."`);
        try {
          const verification = await verifyFact(claim, quest.title);
          const emoji = verification.verified ? '✅' : '❌';
          postGuildMsg(member.agent_id, `${emoji} Fact-check: "${claim.slice(0, 50)}..." → ${verification.verified ? 'VERIFIED' : 'UNVERIFIED'} (${verification.confidence}). ${verification.reasoning}`, {
            tool: 'Fact Checker',
            verdict: verification.verified ? 'verified' : 'unverified',
            confidence: verification.confidence,
            sources: verification.sources.map(url => ({ url }))
          });
          for (const src of verification.sources) {
            if (!allSources.has(src)) {
              allSources.add(src);
              plan.sources.push({ title: 'Fact-check source', url: src });
            }
          }
        } catch (e) {
          postGuildMsg(member.agent_id, `⚠️ Fact-check failed: ${e.message}`);
        }
        await sleep(1500);
      }

      await sleep(1000);
    }

    // ══════════════════════════════════════════
    // PHASE 4: Each agent analyzes their findings
    // ══════════════════════════════════════════
    const agentAnalyses = [];

    for (const plan of agentPlans) {
      const { member, findings } = plan;
      if (!findings.length) {
        // Agent uses own knowledge as fallback
        postGuildMsg(member.agent_id, `💭 No web sources found. Using my own knowledge.`);
        const knowledgeResult = await callKimi(
          `You are ${member.arch.name}. Use your knowledge about: "${quest.title}". ${quest.description}. Write 2-3 paragraphs of analysis.`,
          '', { maxTokens: 400, temperature: 0.7 }
        );
        if (knowledgeResult?.text) {
          agentAnalyses.push({ agent: member.arch.name, agentId: member.agent_id, analysis: knowledgeResult.text, sources: [] });
          const excerpt = knowledgeResult.text.split('\n')[0]?.slice(0, 150);
          postGuildMsg(member.agent_id, `💭 ${excerpt}...`);
        }
        continue;
      }

      const sourceSummary = findings.map((f, i) => `[${i + 1}] ${f.title} (${f.type})\n${f.content.slice(0, 1500)}`).join('\n\n---\n\n');

      const analysisResult = await callKimi(
        `You are ${member.arch.name} (${member.arch.title}). ${member.arch.personality}

You researched: "${quest.title}"
You found ${findings.length} sources. Synthesize YOUR findings:
- Key facts (cite [1], [2] etc.)
- Entities discovered
- Connections between entities
- What surprised you or contradicts common assumptions

Stay in character. 3-4 paragraphs.`,
        sourceSummary,
        { maxTokens: 500, temperature: 0.7 }
      );

      if (analysisResult?.text) {
        agentAnalyses.push({ agent: member.arch.name, agentId: member.agent_id, analysis: analysisResult.text, sources: plan.sources });
        const excerpt = analysisResult.text.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 180);
        postGuildMsg(member.agent_id, `📊 My analysis: ${excerpt}...`, {
          tool: 'Analysis',
          sources: plan.sources
        });
      }
      await sleep(2000);
    }

    if (!agentAnalyses.length) {
      postGuildMsg(leader.agent_id, `⚠️ Quest failed — no agent could produce analysis. Will retry later.`);
      db.prepare("UPDATE quests SET status = 'proposed' WHERE id = ?").run(questId);
      isRunning = false;
      return;
    }

    // ══════════════════════════════════════════
    // PHASE 5: Collaborative .md writing — ALL agents contribute
    // ══════════════════════════════════════════
    postGuildMsg(leader.agent_id, `📝 All ${agentAnalyses.length} analyses in. Let's write the report together.`);
    await sleep(1500);

    // Each agent writes a section of the .md
    const mdSections = [];

    // Agent 1: Summary + Key Findings
    const writer1 = agentAnalyses[0];
    const section1Result = await callKimi(
      `You are ${writer1.agent}. Write these sections for a collaborative research report on "${quest.title}":

# ${quest.title}

## Summary
(3-4 sentence overview based on ALL team findings below)

## Key Findings
(bullet points — combine findings from all researchers, cite sources)

TEAM FINDINGS:
${agentAnalyses.map(a => `### ${a.agent}'s Research:\n${a.analysis}`).join('\n\n')}

Write in Markdown. Be thorough and specific.`,
      '', { maxTokens: 500, temperature: 0.5 }
    );
    if (section1Result?.text) {
      mdSections.push(section1Result.text);
      postGuildMsg(writer1.agentId, `✍️ Wrote: Summary + Key Findings`);
    }
    await sleep(1500);

    // Agent 2: Entities + Connections
    const writer2 = agentAnalyses[1] || agentAnalyses[0];
    const section2Result = await callKimi(
      `You are ${writer2.agent}. Write these sections for the research report on "${quest.title}":

## Entities
(list all entities discovered by the team: - **Name** (type) — description)

## Connections
(list relationships: - Entity A → relationship → Entity B)

TEAM FINDINGS:
${agentAnalyses.map(a => `### ${a.agent}:\n${a.analysis}`).join('\n\n')}

Extract ALL entities and connections mentioned. Be comprehensive. Markdown format.`,
      '', { maxTokens: 400, temperature: 0.5 }
    );
    if (section2Result?.text) {
      mdSections.push(section2Result.text);
      postGuildMsg(writer2.agentId, `✍️ Wrote: Entities + Connections`);
    }
    await sleep(1500);

    // Agent 3 (or 1): Contradictions + Open Questions
    const writer3 = agentAnalyses[2] || agentAnalyses[0];
    const section3Result = await callKimi(
      `You are ${writer3.agent}. Write these sections for the research report on "${quest.title}":

## Contradictions & Debates
(where sources or researchers disagree)

## Open Questions
(what still needs investigation — be specific)

TEAM FINDINGS:
${agentAnalyses.map(a => `### ${a.agent}:\n${a.analysis}`).join('\n\n')}

Be honest about gaps and disagreements. Markdown format.`,
      '', { maxTokens: 300, temperature: 0.6 }
    );
    if (section3Result?.text) {
      mdSections.push(section3Result.text);
      postGuildMsg(writer3.agentId, `✍️ Wrote: Contradictions + Open Questions`);
    }
    await sleep(1000);

    // Sources section — all sources from all agents
    const allSourcesList = [];
    const seenUrls = new Set();
    for (const plan of agentPlans) {
      for (const src of plan.sources) {
        if (!seenUrls.has(src.url)) {
          seenUrls.add(src.url);
          allSourcesList.push(src);
        }
      }
    }
    const sourcesSection = `\n## Sources\n${allSourcesList.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n')}\n\n## Contributors\n${agentAnalyses.map(a => `- **${a.agent}**`).join('\n')}`;
    mdSections.push(sourcesSection);

    // Assemble final .md
    const mdContent = mdSections.join('\n\n');

    // Save .md file
    const filename = quest.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) + '.md';
    const filepath = join(QUEST_DIR, filename);
    writeFileSync(filepath, mdContent, 'utf8');
    console.log(`[QuestRunner] Output saved: ${filepath}`);

    // ══════════════════════════════════════════
    // PHASE 6: Announce output + ingest into brain
    // ══════════════════════════════════════════
    const agentIdsList = teamArchs.map(t => t.agent_id).join(',');

    postGuildMsg(leader.agent_id, `📄 Report saved: ${filename} (${mdContent.length} chars, ${allSourcesList.length} sources)`, {
      tool: 'Write File',
      path: `quests/${filename}`,
      sources: allSourcesList.slice(0, 5)
    });
    await sleep(1500);

    // Ingest into brain
    try {
      await ingestQuestOutput(filepath, questId, agentIdsList);
      postGuildMsg(leader.agent_id, `🧠 Report ingested into Brain knowledge graph. New entities and connections extracted.`, {
        tool: 'Brain Ingestion',
        path: `quests/${filename}`
      });
    } catch (e) {
      console.error('[QuestRunner] Brain ingest error:', e.message);
      postGuildMsg(leader.agent_id, `⚠️ Brain ingestion failed: ${e.message}`);
    }

    // Mark quest completed
    db.prepare("UPDATE quests SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(questId);

    postGuildMsg(leader.agent_id, `✅ Quest completed: "${quest.title}". ${teamArchs.length} agents, ${allSourcesList.length} sources, report saved.`);
    broadcast('quest-completed', { id: questId, title: quest.title, filename, team: teamNames });

    // Trigger validation
    try {
      const { scheduleValidation } = await import('./validation.js');
      const artifact = db.prepare('SELECT id FROM brain_artifacts WHERE quest_id = ? ORDER BY id DESC LIMIT 1').get(questId);
      if (artifact) {
        postGuildMsg(leader.agent_id, `🔬 Validation queued — agents will verify the report's claims.`);
        scheduleValidation(artifact.id);
      }
    } catch (e) { console.error('[QuestRunner] Validation trigger error:', e.message); }

  } catch (err) {
    console.error(`[QuestRunner] Error on quest ${questId}:`, err.message);
    postGuildMsg(team[0]?.agent_id || 'system', `⚠️ Quest "${quest.title}" hit an error: ${err.message}. Will retry.`);
    db.prepare("UPDATE quests SET status = 'proposed' WHERE id = ?").run(questId);
  } finally {
    isRunning = false;
  }
}

// Auto-pick and execute the highest priority proposed quest
export async function runNextQuest() {
  if (isRunning) return;

  const quest = db.prepare(`
    SELECT * FROM quests WHERE status = 'proposed'
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 1
  `).get();

  if (!quest) return;

  await executeQuest(quest.id);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
