// REMOVED: RECOMMENDED_PROMPT_PREFIX conflicts with proactive greeting - it tells agent to "wait for user input"
import { RealtimeAgent, tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { CampaignAdapter } from '../db/agentAdapters';

const SYSTEM_PROMPT_TEMPLATE = `You are an expert Fantasy Football advisor with access to real-time NFL player data via the Sleeper API. It's currently the 2025 NFL season.

YOUR PERSONALITY:
- Enthusiastic, knowledgeable, and conversational
- Talk like a fantasy football expert, not a robot
- Use casual language ("Let's check out...", "Man, that's a tough call", "I'm looking at the numbers right now...")
- Be opinionated but fair - give pros and cons
- Reference real stats to back up your advice

CALL FLOW:
1. **Introduction**:
   "Hey {CONTACT_NAME}! This is your Fantasy Football AI advisor calling. I've got real-time access to all the 2025 NFL stats and I'm here to help with your fantasy team. Are you ready to talk some football?"

2. **Engagement**:
   Ask what they need help with:
   - Lineup decisions (who to start/sit)
   - Trade evaluations (should I make this trade?)
   - Waiver wire pickups (who should I grab?)
   - Player comparisons (who's better ROS?)

3. **Analysis**:
   Use your tools to look up REAL 2025 season data before giving advice

4. **Conversation Style**:
   - Keep responses natural and conversational - break up long explanations
   - Ask follow-up questions to understand their team situation
   - Be enthusiastic and engaged!

TOOLS YOU HAVE:
- getPlayerStats: Look up current 2025 season stats through the most recent week
- getPlayerInfo: Get player details (team, position, status)
- comparePlayers: Side-by-side comparison of multiple players with 2025 stats
- getTopPlayers: Get top performers by position

ADVICE GUIDELINES:
- ALWAYS check real 2025 season stats before making recommendations
- Stats are updated through the most recent week, so they're current
- Consider: recent performance, matchups, injuries, team situations
- For trades: evaluate both sides fairly based on actual production
- For lineups: factor in opponent strength and player consistency
- For waiver pickups: look at opportunity and trend lines

IMPORTANT RULES:
- Never make up stats - if you don't have data, use your tools to get it
- All stats are from the 2025 NFL season through the current week
- If a player isn't found, suggest similar names or ask for clarification
- Keep responses between 5-10 seconds unless doing detailed analysis
- Let the caller interrupt you - they may have follow-up questions
- Be honest about uncertainty ("That's a coin flip, here's why...")

CONVERSATION EXAMPLES:
"Okay, let me pull up his 2025 numbers real quick... *uses tool* ... Alright, so through Week 12 he's got 87 catches for 1,204 yards. Here's what I'm thinking..."

"That's a tough trade. Let me compare these guys with their current stats... *uses tool* ... Okay, based on what they've done this season..."

"Who are you deciding between for your flex spot? Let me check their recent production..."

TONE: Expert friend helping out with fantasy, not a formal advisor. Have fun with it!`;

// Helper function to fetch from Sleeper API
async function sleeperFetch(endpoint: string): Promise<any> {
  const baseUrl = 'https://api.sleeper.app/v1';
  const url = `${baseUrl}${endpoint}`;
  
  console.log(`[SLEEPER API] Fetching: ${url}`);
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    console.log(`[SLEEPER API] Success: ${endpoint}`);
    return data;
  } catch (error) {
    console.error(`[SLEEPER API ERROR] ${endpoint}:`, error);
    throw error;
  }
}

// Get current NFL season and week
function getCurrentNFLSeasonInfo(): { season: number; week: number } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-11
  
  // NFL season starts in September (month 8) and runs through February (month 1)
  // If we're in Jan-Feb, it's still the previous year's season
  const season = month <= 1 ? year - 1 : year;
  
  // Approximate current week (Week 1 starts ~Sept 5, each week is 7 days)
  // November 2025 = Week 10-12 range
  const seasonStartDate = new Date(season, 8, 5); // Sept 5th
  const daysSinceStart = Math.floor((now.getTime() - seasonStartDate.getTime()) / (1000 * 60 * 60 * 24));
  const week = Math.min(18, Math.max(1, Math.floor(daysSinceStart / 7) + 1));
  
  console.log(`[NFL SEASON] Current season: ${season}, Week: ${week}`);
  return { season, week };
}

// Cache for NFL players data (loaded once per session)
let nflPlayersCache: Record<string, any> | null = null;

async function getNFLPlayers(): Promise<Record<string, any>> {
  if (nflPlayersCache) {
    return nflPlayersCache;
  }
  
  console.log('[SLEEPER API] Loading all NFL players...');
  nflPlayersCache = await sleeperFetch('/players/nfl');
  const count = nflPlayersCache ? Object.keys(nflPlayersCache).length : 0;
  console.log(`[SLEEPER API] Loaded ${count} NFL players`);
  return nflPlayersCache!;
}

// Helper to search for player by name
async function findPlayerByName(playerName: string): Promise<any | null> {
  const players = await getNFLPlayers();
  const searchLower = playerName.toLowerCase().trim();
  
  // Try exact match first
  for (const [id, player] of Object.entries(players)) {
    const fullName = `${player.first_name} ${player.last_name}`.toLowerCase();
    if (fullName === searchLower) {
      return { id, ...player };
    }
  }
  
  // Try partial match
  for (const [id, player] of Object.entries(players)) {
    const fullName = `${player.first_name} ${player.last_name}`.toLowerCase();
    if (fullName.includes(searchLower) || searchLower.includes(fullName)) {
      return { id, ...player };
    }
  }
  
  return null;
}

// Factory function to create the fantasy football agent
export function createFantasyFootballAgent(
  metadata?: { campaignId?: string; contactId?: string; contactName?: string }
) {
  // Extract metadata
  const campaignId = metadata?.campaignId;
  const contactId = metadata?.contactId;
  
  console.log('[Fantasy Football Agent] Creating agent with metadata:', { campaignId, contactId });

  // Default contact name - will be 'there' unless provided via metadata.contactName
  let contactName = metadata?.contactName || 'there';
  
  console.log(`[Fantasy Football Agent] Using contact name: ${contactName}`);

  // Tool: Get player information
  const getPlayerInfoTool = tool({
    name: 'getPlayerInfo',
    description: 'Get detailed information about an NFL player including team, position, and status. Use this to check if a player is active, injured, or what team they play for.',
    parameters: z.object({
      playerName: z.string().describe('The player\'s full name (e.g., "Patrick Mahomes", "Justin Jefferson")'),
    }),
    execute: async ({ playerName }) => {
      console.log(`[TOOL] getPlayerInfo: ${playerName}`);
      
      try {
        const player = await findPlayerByName(playerName);
        
        if (!player) {
          return `I couldn't find a player named "${playerName}". Could you double-check the spelling or try a different name?`;
        }
        
        const info = {
          name: `${player.first_name} ${player.last_name}`,
          team: player.team || 'Free Agent',
          position: player.position,
          number: player.number || 'N/A',
          status: player.status || 'Active',
          age: player.age || 'Unknown',
          height: player.height || 'Unknown',
          weight: player.weight || 'Unknown',
          college: player.college || 'Unknown',
          yearsExp: player.years_exp || 0,
        };
        
        return `Found ${info.name}:\n- Team: ${info.team}\n- Position: ${info.position} #${info.number}\n- Status: ${info.status}\n- Age: ${info.age}, ${info.yearsExp} years pro\n- College: ${info.college}`;
      } catch (error: any) {
        console.error('[TOOL ERROR] getPlayerInfo:', error);
        return `Sorry, I had trouble looking up that player. ${error.message}`;
      }
    },
  });

  // Tool: Get player stats with real Sleeper API integration
  const getPlayerStatsTool = tool({
    name: 'getPlayerStats',
    description: 'Get current 2025 season statistics for an NFL player up through the most recent week. Returns fantasy-relevant stats like touchdowns, yards, receptions, PPR points, etc.',
    parameters: z.object({
      playerName: z.string().describe('The player\'s full name'),
    }),
    execute: async ({ playerName }) => {
      console.log(`[TOOL] getPlayerStats: ${playerName}`);
      
      try {
        const player = await findPlayerByName(playerName);
        
        if (!player) {
          return `I couldn't find stats for "${playerName}". Make sure the name is spelled correctly.`;
        }
        
        const playerId = player.id;
        const playerFullName = `${player.first_name} ${player.last_name}`;
        
        // Get current NFL season info
        const { season, week } = getCurrentNFLSeasonInfo();
        
        // Fetch current season stats from Sleeper (season totals through current week)
        const statsUrl = `https://api.sleeper.com/stats/nfl/player/${playerId}?season_type=regular&season=${season}&grouping=season`;
        console.log(`[SLEEPER API] Fetching stats for ${season} season: ${statsUrl}`);
        
        const statsResponse = await fetch(statsUrl);
        if (!statsResponse.ok) {
          return `${playerFullName} (${player.team} ${player.position}) - Stats not available yet for ${season} season. They may not have played or stats are still being updated.`;
        }
        
        const statsData = await statsResponse.json();
        
        // Sleeper returns an array of season objects; grab the first one
        const seasonStats = Array.isArray(statsData) ? statsData[0] : statsData;
        
        // Check if we got valid stats
        if (!seasonStats || !seasonStats.stats || Object.keys(seasonStats.stats).length === 0) {
          return `${playerFullName} (${player.team} ${player.position}) - No stats available yet for the ${season} season.`;
        }
        
        const s = seasonStats.stats;
        const pos = player.position;
        
        // Format stats based on position
        let result = `${playerFullName} (${player.team} ${pos}) - ${season} Season (through Week ${week}):\n\n`;
        
        if (pos === 'QB') {
          result += `Passing: ${s.pass_yd || 0} yds, ${s.pass_td || 0} TDs, ${s.pass_int || 0} INTs\n`;
          result += `Rushing: ${s.rush_yd || 0} yds, ${s.rush_td || 0} TDs\n`;
        } else if (pos === 'RB') {
          result += `Rushing: ${s.rush_att || 0} att, ${s.rush_yd || 0} yds, ${s.rush_td || 0} TDs\n`;
          result += `Receiving: ${s.rec || 0} rec, ${s.rec_yd || 0} yds, ${s.rec_td || 0} TDs\n`;
        } else if (pos === 'WR' || pos === 'TE') {
          result += `Receiving: ${s.rec || 0} rec, ${s.rec_yd || 0} yds, ${s.rec_td || 0} TDs\n`;
          result += `Targets: ${s.rec_tgt || 0}\n`;
        } else if (pos === 'K') {
          result += `FG: ${s.fgm || 0}/${s.fga || 0}, XP: ${s.xpm || 0}/${s.xpa || 0}\n`;
        }
        
        // Fantasy points
        result += `\nFantasy Points:\n`;
        result += `- PPR: ${s.pts_ppr?.toFixed(2) || '0.00'}\n`;
        result += `- Standard: ${s.pts_std?.toFixed(2) || '0.00'}\n`;
        result += `Games Played: ${s.gp || 0}`;
        
        return result;
      } catch (error: any) {
        console.error('[TOOL ERROR] getPlayerStats:', error);
        return `Had trouble getting stats for that player. The stats API might be temporarily unavailable.`;
      }
    },
  });

  // Tool: Compare multiple players with real stats
  const comparePlayersTool = tool({
    name: 'comparePlayers',
    description: 'Compare multiple NFL players side-by-side with their current 2025 season stats through the most recent week. Great for trade evaluations or lineup decisions.',
    parameters: z.object({
      playerNames: z.array(z.string()).min(2).max(4).describe('Array of 2-4 player names to compare'),
    }),
    execute: async ({ playerNames }) => {
      console.log(`[TOOL] comparePlayers: ${playerNames.join(', ')}`);
      
      try {
        // Get current NFL season info
        const { season, week } = getCurrentNFLSeasonInfo();
        
        const comparisons = [];
        
        for (const name of playerNames) {
          const player = await findPlayerByName(name);
          if (!player) {
            comparisons.push({ name, error: 'Player not found' });
            continue;
          }
          
          const playerFullName = `${player.first_name} ${player.last_name}`;
          
          // Fetch stats
          try {
            const statsUrl = `https://api.sleeper.com/stats/nfl/player/${player.id}?season_type=regular&season=${season}&grouping=season`;
            const statsResponse = await fetch(statsUrl);
            
            let stats = null;
            if (statsResponse.ok) {
              const data = await statsResponse.json();
              // Sleeper returns an array of season objects; grab the first one
              const seasonStats = Array.isArray(data) ? data[0] : data;
              stats = seasonStats?.stats;
            }
            
            comparisons.push({
              name: playerFullName,
              team: player.team || 'FA',
              position: player.position,
              stats: stats,
              hasStats: stats && Object.keys(stats).length > 0,
            });
          } catch (error) {
            comparisons.push({
              name: playerFullName,
              team: player.team || 'FA',
              position: player.position,
              error: 'Stats unavailable',
            });
          }
        }
        
        let result = `📊 Player Comparison (${season} Season - Week ${week}):\n\n`;
        
        comparisons.forEach((p: any, i) => {
          result += `${i + 1}. ${p.name}`;
          
          if (p.error) {
            result += ` - ${p.error}\n`;
            return;
          }
          
          result += ` (${p.team} ${p.position})\n`;
          
          if (!p.hasStats) {
            result += `   No stats yet\n`;
          } else {
            const s = p.stats;
            const pos = p.position;
            
            if (pos === 'QB') {
              result += `   Pass: ${s.pass_yd || 0} yds, ${s.pass_td || 0} TD | Rush: ${s.rush_yd || 0} yds\n`;
            } else if (pos === 'RB') {
              result += `   Rush: ${s.rush_yd || 0} yds, ${s.rush_td || 0} TD | Rec: ${s.rec || 0} rec, ${s.rec_yd || 0} yds\n`;
            } else if (pos === 'WR' || pos === 'TE') {
              result += `   Rec: ${s.rec || 0} rec, ${s.rec_yd || 0} yds, ${s.rec_td || 0} TD | Tgt: ${s.rec_tgt || 0}\n`;
            }
            
            result += `   PPR Points: ${s.pts_ppr?.toFixed(1) || '0.0'} | Games: ${s.gp || 0}\n`;
          }
        });
        
        return result;
      } catch (error: any) {
        console.error('[TOOL ERROR] comparePlayers:', error);
        return `Ran into an issue comparing those players. ${error.message}`;
      }
    },
  });

  // Tool: Get top players by position
  const getTopPlayersTool = tool({
    name: 'getTopPlayers',
    description: 'Get a list of top players at a specific position. Useful for waiver wire advice or draft prep.',
    parameters: z.object({
      position: z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']).describe('Position to search for'),
      limit: z.number().min(3).max(20).default(10).describe('How many players to return (default 10)'),
    }),
    execute: async ({ position, limit }) => {
      console.log(`[TOOL] getTopPlayers: ${position} (limit: ${limit})`);
      
      try {
        const players = await getNFLPlayers();
        const positionPlayers: any[] = [];
        
        for (const [id, player] of Object.entries(players)) {
          if (player.position === position && player.active && player.team) {
            positionPlayers.push({
              name: `${player.first_name} ${player.last_name}`,
              team: player.team,
              age: player.age,
              yearsExp: player.years_exp || 0,
            });
          }
        }
        
        // Sort by years of experience as a proxy for established players
        // In production, you'd sort by actual fantasy points
        positionPlayers.sort((a, b) => b.yearsExp - a.yearsExp);
        
        const topPlayers = positionPlayers.slice(0, limit);
        
        let result = `Top ${limit} ${position}s:\n\n`;
        topPlayers.forEach((p, i) => {
          result += `${i + 1}. ${p.name} (${p.team}) - ${p.yearsExp} yrs exp\n`;
        });
        
        return result + '\nNote: This is based on player database. For real-time rankings, I\'d need stat integration. But I can still discuss these guys!';
      } catch (error: any) {
        console.error('[TOOL ERROR] getTopPlayers:', error);
        return `Had trouble getting the top ${position}s. ${error.message}`;
      }
    },
  });

  // Inject contact name into system prompt (computed above)
  const personalizedPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{CONTACT_NAME}', contactName);
  
  // Add campaign context if available
  const metadataContext = (campaignId && contactId) 
    ? `\n\nCAMPAIGN CONTEXT:\nYou are calling as part of campaign ID: ${campaignId}\nContact ID: ${contactId}\nContact Name: ${contactName}`
    : '';

  // Create the agent with all tools
  return new RealtimeAgent({
    name: 'Fantasy Football Advisor',
    handoffDescription: 'Expert fantasy football advisor with real-time NFL player data access via Sleeper API',
    instructions: () => {
      // MUST be synchronous - contact name was pre-computed above
      return `${personalizedPrompt}${metadataContext}`;
    },
    tools: [
      getPlayerInfoTool,
      getPlayerStatsTool,
      comparePlayersTool,
      getTopPlayersTool,
    ],
  });
}

// Create a default agent instance for registry
export const fantasyFootballAgent = createFantasyFootballAgent();

