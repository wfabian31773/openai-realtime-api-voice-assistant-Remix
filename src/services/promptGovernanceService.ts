import { db } from '../../server/db';
import { promptVersions } from '../../shared/schema';
import { eq, sql, and, desc } from 'drizzle-orm';

class PromptGovernanceService {
  
  async createVersion(agentSlug: string, promptContent: string, metadata?: Record<string, any>): Promise<any> {
    const latest = await db.select({ maxVersion: sql<number>`COALESCE(MAX(version), 0)` })
      .from(promptVersions)
      .where(eq(promptVersions.agentSlug, agentSlug));
    
    const nextVersion = (latest[0]?.maxVersion || 0) + 1;
    
    const [created] = await db.insert(promptVersions).values({
      agentSlug,
      version: nextVersion,
      promptContent,
      status: 'draft',
      metadata,
    }).returning();
    
    console.info(`[PROMPT-GOV] Created version ${nextVersion} for agent "${agentSlug}"`);
    return created;
  }

  async promoteVersion(versionId: string, promotedBy: string, reason: string, evalRunId?: string): Promise<any> {
    const [version] = await db.select().from(promptVersions).where(eq(promptVersions.id, versionId));
    if (!version) throw new Error(`Version ${versionId} not found`);
    if (version.status === 'active') throw new Error(`Version ${versionId} is already active`);
    
    await db.update(promptVersions)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(and(
        eq(promptVersions.agentSlug, version.agentSlug),
        eq(promptVersions.status, 'active')
      ));
    
    const [promoted] = await db.update(promptVersions)
      .set({
        status: 'active',
        promotedBy,
        promotionReason: reason,
        evalRunId: evalRunId || null,
        updatedAt: new Date(),
      })
      .where(eq(promptVersions.id, versionId))
      .returning();
    
    console.info(`[PROMPT-GOV] Promoted version ${version.version} for agent "${version.agentSlug}" by ${promotedBy}`);
    return promoted;
  }

  async rollbackToVersion(agentSlug: string, targetVersion: number, rolledBackBy: string, reason: string): Promise<any> {
    const [target] = await db.select().from(promptVersions)
      .where(and(
        eq(promptVersions.agentSlug, agentSlug),
        eq(promptVersions.version, targetVersion)
      ));
    
    if (!target) throw new Error(`Version ${targetVersion} not found for agent "${agentSlug}"`);
    
    await db.update(promptVersions)
      .set({ 
        status: 'rolled_back', 
        rolledBackBy,
        rolledBackAt: new Date(),
        rollbackReason: reason,
        updatedAt: new Date() 
      })
      .where(and(
        eq(promptVersions.agentSlug, agentSlug),
        eq(promptVersions.status, 'active')
      ));
    
    const [activated] = await db.update(promptVersions)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(promptVersions.id, target.id))
      .returning();
    
    console.info(`[PROMPT-GOV] Rolled back agent "${agentSlug}" to version ${targetVersion} by ${rolledBackBy}: ${reason}`);
    return activated;
  }

  async forceRollback(agentSlug: string, rolledBackBy: string, reason: string): Promise<any> {
    const [previous] = await db.select().from(promptVersions)
      .where(and(
        eq(promptVersions.agentSlug, agentSlug),
        eq(promptVersions.status, 'archived')
      ))
      .orderBy(desc(promptVersions.version))
      .limit(1);
    
    if (!previous) throw new Error(`No previous version found for agent "${agentSlug}" to roll back to`);
    
    return this.rollbackToVersion(agentSlug, previous.version, rolledBackBy, reason);
  }

  async getActiveVersion(agentSlug: string): Promise<any | null> {
    const [active] = await db.select().from(promptVersions)
      .where(and(
        eq(promptVersions.agentSlug, agentSlug),
        eq(promptVersions.status, 'active')
      ));
    return active || null;
  }

  async getVersionHistory(agentSlug: string, limit: number = 20): Promise<any[]> {
    return db.select().from(promptVersions)
      .where(eq(promptVersions.agentSlug, agentSlug))
      .orderBy(desc(promptVersions.version))
      .limit(limit);
  }

  async getAllAgentVersions(): Promise<any[]> {
    return db.execute(sql`
      SELECT DISTINCT ON (agent_slug) 
        agent_slug, version, status, promoted_by, promotion_reason, eval_run_id, created_at, updated_at
      FROM prompt_versions 
      WHERE status = 'active'
      ORDER BY agent_slug, version DESC
    `).then(r => r.rows);
  }
}

export const promptGovernanceService = new PromptGovernanceService();
