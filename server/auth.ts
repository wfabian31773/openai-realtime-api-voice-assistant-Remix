import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from './db';
import { users, userInvitations, passwordResetTokens } from '../shared/schema';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { sendInviteEmail, sendPasswordResetEmail, sendWelcomeEmail, sendPasswordChangedEmail, sendRoleChangedEmail, sendAccountDeactivatedEmail } from './services/emailService';

const SALT_ROUNDS = 12;
const INVITE_EXPIRY_DAYS = 7;
const RESET_TOKEN_EXPIRY_HOURS = 1;

export const authRouter = Router();

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    userRole?: string;
  }
}

function generateSecureToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function requireAuth(req: any, res: Response, next: NextFunction) {
  // Support both custom session auth and Replit Auth
  if (req.session?.userId) {
    return next();
  }
  if (req.user?.claims?.sub) {
    return next();
  }
  return res.status(401).json({ error: 'Authentication required' });
}

export function requireRole(...allowedRoles: string[]) {
  return async (req: any, res: Response, next: NextFunction) => {
    // Support both custom session auth and Replit Auth
    let userRole: string | undefined;
    
    if (req.session?.userId) {
      // Custom auth - role stored in session
      userRole = req.session.userRole;
      
      // If role not in session, fetch from database
      if (!userRole) {
        const [user] = await db.select({ role: users.role })
          .from(users)
          .where(eq(users.id, req.session.userId));
        if (user) {
          userRole = user.role || 'user';
          req.session.userRole = userRole;
        }
      }
    } else if (req.user?.claims?.sub) {
      // Replit Auth - fetch role from database
      const [user] = await db.select({ role: users.role })
        .from(users)
        .where(eq(users.id, req.user.claims.sub));
      if (user) {
        userRole = user.role || 'user';
      }
    }
    
    if (!userRole) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  return requireRole('admin')(req, res, next);
}

export function requireManager(req: Request, res: Response, next: NextFunction) {
  return requireRole('admin', 'manager')(req, res, next);
}

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Account is not active. Please contact your administrator.' });
    }
    
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    await db.update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    
    req.session.userId = user.id;
    req.session.userRole = user.role || 'user';
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status,
      },
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[AUTH] Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId));
    
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'User not found' });
    }
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status,
        profileImageUrl: user.profileImageUrl,
      },
    });
  } catch (error) {
    console.error('[AUTH] Get current user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

authRouter.post('/invite', requireRole('admin', 'manager'), async (req: Request, res: Response) => {
  try {
    const { email, role } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const validRoles = ['admin', 'manager', 'user'];
    const assignRole = validRoles.includes(role) ? role : 'user';
    
    if (req.session.userRole === 'manager' && assignRole === 'admin') {
      return res.status(403).json({ error: 'Managers cannot invite admins' });
    }
    
    const [existingUser] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (existingUser) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }
    
    const [existingInvite] = await db.select()
      .from(userInvitations)
      .where(
        and(
          eq(userInvitations.email, email.toLowerCase()),
          isNull(userInvitations.acceptedAt),
          gt(userInvitations.expiresAt, new Date())
        )
      );
    
    if (existingInvite) {
      return res.status(400).json({ error: 'An active invitation already exists for this email' });
    }
    
    const token = generateSecureToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);
    
    const [inviter] = await db.select().from(users).where(eq(users.id, req.session.userId!));
    const inviterName = inviter ? `${inviter.firstName || ''} ${inviter.lastName || ''}`.trim() || inviter.email : 'An administrator';
    
    const [invitation] = await db.insert(userInvitations)
      .values({
        email: email.toLowerCase(),
        token,
        role: assignRole as 'admin' | 'manager' | 'user',
        invitedBy: req.session.userId,
        expiresAt,
      })
      .returning();
    
    const emailSent = await sendInviteEmail(email, token, inviterName, assignRole);
    
    res.json({
      success: true,
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
      emailSent,
    });
  } catch (error) {
    console.error('[AUTH] Invite error:', error);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

authRouter.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    
    const [invitation] = await db.select()
      .from(userInvitations)
      .where(
        and(
          eq(userInvitations.token, token),
          isNull(userInvitations.acceptedAt),
          gt(userInvitations.expiresAt, new Date())
        )
      );
    
    if (!invitation) {
      return res.status(400).json({ error: 'Invalid or expired invitation' });
    }
    
    res.json({
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    });
  } catch (error) {
    console.error('[AUTH] Get invitation error:', error);
    res.status(500).json({ error: 'Failed to get invitation' });
  }
});

authRouter.post('/accept-invite', async (req: Request, res: Response) => {
  try {
    const { token, firstName, lastName, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const [invitation] = await db.select()
      .from(userInvitations)
      .where(
        and(
          eq(userInvitations.token, token),
          isNull(userInvitations.acceptedAt),
          gt(userInvitations.expiresAt, new Date())
        )
      );
    
    if (!invitation) {
      return res.status(400).json({ error: 'Invalid or expired invitation' });
    }
    
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    
    const [user] = await db.insert(users)
      .values({
        email: invitation.email,
        passwordHash,
        firstName: firstName || null,
        lastName: lastName || null,
        role: invitation.role || 'user',
        status: 'active',
        emailVerified: true,
      })
      .returning();
    
    await db.update(userInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(userInvitations.id, invitation.id));
    
    await sendWelcomeEmail(user.email!, `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there');
    
    req.session.userId = user.id;
    req.session.userRole = user.role || 'user';
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[AUTH] Accept invite error:', error);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

authRouter.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    
    if (!user) {
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent' });
    }
    
    if (user.status !== 'active') {
      return res.json({ success: true, message: 'If an account exists, a reset link will be sent' });
    }
    
    const token = generateSecureToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + RESET_TOKEN_EXPIRY_HOURS);
    
    await db.insert(passwordResetTokens)
      .values({
        userId: user.id,
        token,
        expiresAt,
      });
    
    const userName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    await sendPasswordResetEmail(user.email!, token, userName);
    
    res.json({ success: true, message: 'If an account exists, a reset link will be sent' });
  } catch (error) {
    console.error('[AUTH] Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

authRouter.get('/reset-password/:token', async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    
    const [resetToken] = await db.select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.token, token),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date())
        )
      );
    
    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
    res.json({ valid: true });
  } catch (error) {
    console.error('[AUTH] Validate reset token error:', error);
    res.status(500).json({ error: 'Failed to validate token' });
  }
});

authRouter.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const [resetToken] = await db.select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.token, token),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date())
        )
      );
    
    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }
    
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    
    const [updatedUser] = await db.update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, resetToken.userId))
      .returning({ email: users.email, firstName: users.firstName });
    
    await db.update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, resetToken.id));
    
    if (updatedUser) {
      await sendPasswordChangedEmail(updatedUser.email, updatedUser.firstName || 'there');
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('[AUTH] Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

authRouter.get('/users', requireRole('admin', 'manager'), async (req: Request, res: Response) => {
  try {
    const allUsers = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    }).from(users);
    
    res.json({ users: allUsers });
  } catch (error) {
    console.error('[AUTH] Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

authRouter.get('/invitations', requireRole('admin', 'manager'), async (req: Request, res: Response) => {
  try {
    const invitations = await db.select()
      .from(userInvitations)
      .where(isNull(userInvitations.acceptedAt));
    
    res.json({ invitations });
  } catch (error) {
    console.error('[AUTH] Get invitations error:', error);
    res.status(500).json({ error: 'Failed to get invitations' });
  }
});

authRouter.put('/users/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { role, status } = req.body;
    
    const [existingUser] = await db.select().from(users).where(eq(users.id, id));
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const oldRole = existingUser.role;
    const oldStatus = existingUser.status;
    
    const updates: { role?: 'admin' | 'manager' | 'user'; status?: 'pending' | 'active' | 'suspended' | 'deactivated'; updatedAt?: Date } = { updatedAt: new Date() };
    
    if (role && ['admin', 'manager', 'user'].includes(role)) {
      updates.role = role;
    }
    
    if (status && ['pending', 'active', 'suspended', 'deactivated'].includes(status)) {
      updates.status = status;
    }
    
    const [updated] = await db.update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userName = updated.firstName || 'there';
    
    if (role && role !== oldRole) {
      await sendRoleChangedEmail(updated.email, userName, role);
    }
    
    if (status === 'deactivated' && oldStatus !== 'deactivated') {
      await sendAccountDeactivatedEmail(updated.email, userName);
    }
    
    res.json({
      user: {
        id: updated.id,
        email: updated.email,
        firstName: updated.firstName,
        lastName: updated.lastName,
        role: updated.role,
        status: updated.status,
      },
    });
  } catch (error) {
    console.error('[AUTH] Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

authRouter.delete('/invitations/:id', requireRole('admin', 'manager'), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    
    await db.delete(userInvitations).where(eq(userInvitations.id, id));
    
    res.json({ success: true });
  } catch (error) {
    console.error('[AUTH] Delete invitation error:', error);
    res.status(500).json({ error: 'Failed to delete invitation' });
  }
});

authRouter.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    
    const [user] = await db.select().from(users).where(eq(users.id, req.session.userId!));
    
    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: 'Cannot change password for this account' });
    }
    
    const validPassword = await bcrypt.compare(currentPassword, user.passwordHash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    
    await db.update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    
    await sendPasswordChangedEmail(user.email, user.firstName || 'there');
    
    res.json({ success: true });
  } catch (error) {
    console.error('[AUTH] Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export async function createFirstAdmin(email: string, password: string): Promise<boolean> {
  try {
    const [existingAdmin] = await db.select().from(users).where(eq(users.role, 'admin'));
    
    if (existingAdmin) {
      console.log('[AUTH] Admin already exists, skipping first admin creation');
      return false;
    }
    
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    
    const [admin] = await db.insert(users)
      .values({
        email: email.toLowerCase(),
        passwordHash,
        firstName: 'Admin',
        lastName: 'User',
        role: 'admin',
        status: 'active',
        emailVerified: true,
      })
      .returning();
    
    console.log(`[AUTH] First admin created: ${admin.email}`);
    return true;
  } catch (error) {
    console.error('[AUTH] Failed to create first admin:', error);
    return false;
  }
}
