// Dungeon Engine — D&D-style roleplay between agents
// One agent is the DM (Dungeon Master), others are players
import db from '../db/database.js';
import { callKimi } from './kimi.js';
import { archetypes } from '../agents/archetypes.js';
import { broadcast } from './discussion.js';

// DM rotates — but defaults to Hypatia (scholar, good storyteller)
const DM_ROTATION = ['hypatia', 'da_vinci', 'rumi', 'arendt'];
const PARTY_SIZE = 4; // 4 players + 1 DM per session

// Character class mapping based on archetype personality
const CHARACTER_CLASSES = {
  sokrates: { class: 'Philosopher-Monk', race: 'Human', trait: 'asks devastating questions mid-combat' },
  da_vinci: { class: 'Artificer', race: 'Gnome', trait: 'sketches inventions during downtime' },
  sunzi: { class: 'War Strategist (Fighter)', race: 'Human', trait: 'always has a contingency plan' },
  hypatia: { class: 'Arcane Scholar (Wizard)', race: 'Elf', trait: 'corrects historical inaccuracies in the narrative' },
  nietzsche: { class: 'Warlock of the Abyss', race: 'Tiefling', trait: 'monologues about power before attacking' },
  confucius: { class: 'Cleric of Order', race: 'Human', trait: 'insists on proper ritual before every action' },
  curie: { class: 'Alchemist (Artificer)', race: 'Human', trait: 'experiments with everything she finds' },
  rumi: { class: 'Mystic Bard', race: 'Half-Elf', trait: 'speaks in poetry even in battle' },
  ada: { class: 'Rune Knight', race: 'Dwarf', trait: 'finds patterns in dungeon layouts' },
  diogenes: { class: 'Barbarian Vagrant', race: 'Half-Orc', trait: 'insults authority figures, sleeps in barrels' },
  arendt: { class: 'Inquisitor (Paladin)', race: 'Human', trait: 'interrogates NPCs about their moral choices' },
  tesla: { class: 'Storm Sorcerer', race: 'Air Genasi', trait: 'obsessed with lightning-based solutions' },
};

// Scenario templates
const SCENARIOS = [
  'A mysterious plague spreads through a port city. The Guild of Healers has vanished. Dark rituals are rumored beneath the harbor.',
  'An ancient library has been unearthed beneath the desert. Its guardian constructs still roam the halls. The knowledge within could change the world.',
  'A dragon has claimed a mountain fortress as its lair. But this dragon wants to negotiate, not fight. What does it truly want?',
  'The barrier between worlds is thinning. Strange creatures appear at crossroads. A wandering oracle says only "the door was opened from our side."',
  'A merchant prince offers 10,000 gold to retrieve a painting from a rival\'s vault. Simple heist. But the painting whispers to those who look at it.',
  'A village celebrates a harvest festival, but no one can remember what happened last year\'s festival. Or the year before. Something feeds on their memories.',
  'War machines from a fallen empire have activated on their own. They march toward the capital. Inside one, someone left a message: "I\'m sorry."',
  'The party wakes up in an unfamiliar tavern. None of them remember how they got here. The barkeep says they arrived three days ago — and paid in advance.',
];

function getRecentMessages(limit = 15) {
  return db.prepare('SELECT * FROM dungeon_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

function postDungeonMsg(agentId, content, role = 'player') {
  const info = db.prepare(
    'INSERT INTO dungeon_messages (agent_id, content, role) VALUES (?, ?, ?)'
  ).run(agentId, content, role);
  
  const arch = archetypes.find(a => a.id === agentId);
  const msg = {
    id: info.lastInsertRowid,
    agent_id: agentId,
    agent_name: arch?.name || agentId,
    agent_avatar: arch?.avatar || '🎲',
    agent_color: arch?.color || '#888',
    content,
    role,
    created_at: new Date().toISOString()
  };
  broadcast('dungeon-chat', msg);
  return msg;
}

function getOrCreateState() {
  let state = db.prepare('SELECT * FROM dungeon_state WHERE id = 1').get();
  if (!state) {
    // Pick random DM and players
    const dm = DM_ROTATION[Math.floor(Math.random() * DM_ROTATION.length)];
    const available = archetypes.filter(a => a.id !== dm).map(a => a.id);
    const shuffled = available.sort(() => Math.random() - 0.5);
    const players = shuffled.slice(0, PARTY_SIZE);
    const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    
    db.prepare(
      'INSERT INTO dungeon_state (id, scenario, turn, active_players, dm_id) VALUES (1, ?, 0, ?, ?)'
    ).run(scenario, JSON.stringify(players), dm);
    
    state = db.prepare('SELECT * FROM dungeon_state WHERE id = 1').get();
  }
  return state;
}

// Start a new dungeon session
export async function startNewSession() {
  // Clear old messages (keep last 50 as history)
  db.prepare('DELETE FROM dungeon_messages WHERE id NOT IN (SELECT id FROM dungeon_messages ORDER BY id DESC LIMIT 50)').run();
  
  // Reset state
  db.prepare('DELETE FROM dungeon_state').run();
  const state = getOrCreateState();
  const dm = archetypes.find(a => a.id === state.dm_id);
  const players = JSON.parse(state.active_players);
  const party = players.map(id => {
    const arch = archetypes.find(a => a.id === id);
    const char = CHARACTER_CLASSES[id] || { class: 'Adventurer', race: 'Human', trait: 'mysterious' };
    return `${arch?.name || id} — ${char.race} ${char.class} (${char.trait})`;
  });

  // DM introduces the scenario
  const intro = await callKimi(
    `You are ${dm.name}, the Dungeon Master for a D&D-style adventure.
Your style: vivid, atmospheric, concise. Set the scene in 3-4 sentences.
End with a choice or question for the party.

SCENARIO: ${state.scenario}

THE PARTY:
${party.join('\n')}

Begin the adventure. Set the scene. What do the adventurers see?`,
    '',
    { maxTokens: 300, temperature: 0.9 }
  );

  if (intro?.text) {
    postDungeonMsg(state.dm_id, intro.text, 'dm');
    db.prepare('UPDATE dungeon_state SET turn = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run();
  }

  return state;
}

// One turn of the dungeon — a player responds, then DM narrates
export async function dungeonTick() {
  const state = getOrCreateState();
  if (!state.scenario) return;

  const players = JSON.parse(state.active_players || '[]');
  if (!players.length) return;

  const recentMsgs = getRecentMessages(12);
  const conversation = recentMsgs.map(m => {
    const arch = archetypes.find(a => a.id === m.agent_id);
    const name = arch?.name || m.agent_id;
    const tag = m.role === 'dm' ? '[DM]' : '[Player]';
    return `${tag} ${name}: ${m.content}`;
  }).join('\n');

  // Pick next player (round-robin based on turn)
  const playerIdx = state.turn % players.length;
  const playerId = players[playerIdx];
  const playerArch = archetypes.find(a => a.id === playerId);
  const playerChar = CHARACTER_CLASSES[playerId] || { class: 'Adventurer', race: 'Human', trait: 'mysterious' };

  // Player responds
  const playerResponse = await callKimi(
    `You are ${playerArch.name}, playing D&D as a ${playerChar.race} ${playerChar.class}.
Your trait: ${playerChar.trait}
Your personality: ${playerArch.personality}

Stay in character. Respond to the DM's narration with:
- What you DO (action, movement, interaction)
- What you SAY (in-character dialogue)
- Optional: a skill check or creative approach

Keep it 2-3 sentences. Be creative and true to your character.`,
    `ADVENTURE SO FAR:\n${conversation}`,
    { maxTokens: 200, temperature: 0.9 }
  );

  if (playerResponse?.text) {
    postDungeonMsg(playerId, playerResponse.text, 'player');
  }

  // DM responds to the player's action
  const dmArch = archetypes.find(a => a.id === state.dm_id);
  const updatedConversation = conversation + `\n[Player] ${playerArch.name}: ${playerResponse?.text || '...'}`;

  const dmResponse = await callKimi(
    `You are ${dmArch.name}, the Dungeon Master.
Narrate what happens in response to the player's action.
Include: consequences, environmental details, NPC reactions, or new developments.
If appropriate, call for a dice roll (describe the DC and outcome).
End with something that gives the NEXT player a hook to act.

Keep it 2-4 sentences. Be vivid but concise.`,
    `SCENARIO: ${state.scenario}\n\nADVENTURE SO FAR:\n${updatedConversation}`,
    { maxTokens: 250, temperature: 0.85 }
  );

  if (dmResponse?.text) {
    postDungeonMsg(state.dm_id, dmResponse.text, 'dm');
  }

  // Advance turn
  db.prepare('UPDATE dungeon_state SET turn = turn + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run();

  return { player: playerId, dm: state.dm_id, turn: state.turn + 1 };
}

// Get dungeon messages for API
export function getDungeonMessages(limit = 50) {
  const rows = db.prepare('SELECT * FROM dungeon_messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
  return rows.map(m => {
    const arch = archetypes.find(a => a.id === m.agent_id);
    return {
      ...m,
      agent_name: arch?.name || m.agent_id,
      agent_avatar: arch?.avatar || '🎲',
      agent_color: arch?.color || '#888'
    };
  });
}

// Get current dungeon state
export function getDungeonState() {
  const state = getOrCreateState();
  const players = JSON.parse(state.active_players || '[]');
  return {
    ...state,
    players: players.map(id => {
      const arch = archetypes.find(a => a.id === id);
      const char = CHARACTER_CLASSES[id] || {};
      return { id, name: arch?.name, avatar: arch?.avatar, color: arch?.color, ...char };
    }),
    dm: (() => {
      const arch = archetypes.find(a => a.id === state.dm_id);
      return { id: state.dm_id, name: arch?.name, avatar: arch?.avatar, color: arch?.color };
    })()
  };
}
