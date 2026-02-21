import nodemailer from 'nodemailer';

const SMTP_CONFIG = {
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: 'notifications@me.azulvision.com',
    pass: process.env.SMTP_PASSWORD,
  },
};

const FROM_ADDRESS = 'Azul Vision <notifications@me.azulvision.com>';

const BRAND_COLORS = {
  primary: '#2563eb',
  primaryDark: '#1d4ed8',
  text: '#1f2937',
  textLight: '#6b7280',
  background: '#f8fafc',
  white: '#ffffff',
  border: '#e5e7eb',
  success: '#10b981',
  warning: '#f59e0b',
};

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    if (!process.env.SMTP_PASSWORD) {
      throw new Error('SMTP_PASSWORD environment variable is not set');
    }
    transporter = nodemailer.createTransport(SMTP_CONFIG);
  }
  return transporter;
}

function getButton(text: string, url: string): string {
  return `
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:50px;v-text-anchor:middle;width:200px;" arcsize="20%" strokecolor="${BRAND_COLORS.primary}" fillcolor="${BRAND_COLORS.primary}">
      <w:anchorlock/>
      <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">${text}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-->
    <a href="${url}" style="display:inline-block;padding:16px 40px;background-color:${BRAND_COLORS.primary};color:#ffffff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${text}</a>
    <!--<![endif]-->
  `;
}

function getBaseTemplate(content: string, previewText: string = ''): string {
  return `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <!--[if gte mso 9]>
  <xml>
    <o:OfficeDocumentSettings>
      <o:AllowPNG/>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
  </xml>
  <![endif]-->
  <!--[if mso]>
  <style type="text/css">
    body, table, td, th, p, a, h1, h2, h3, h4, h5, h6 {font-family: Arial, sans-serif !important;}
  </style>
  <![endif]-->
  <title>Azul Vision</title>
  <style type="text/css">
    body {
      margin: 0;
      padding: 0;
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    table, td {
      border-collapse: collapse;
      mso-table-lspace: 0pt;
      mso-table-rspace: 0pt;
    }
    img {
      border: 0;
      height: auto;
      line-height: 100%;
      outline: none;
      text-decoration: none;
      -ms-interpolation-mode: bicubic;
    }
    a[x-apple-data-detectors] {
      color: inherit !important;
      text-decoration: none !important;
    }
    @media only screen and (max-width: 600px) {
      .mobile-padding {
        padding-left: 20px !important;
        padding-right: 20px !important;
      }
      .mobile-full-width {
        width: 100% !important;
      }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_COLORS.background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  
  <!-- Preview Text -->
  <div style="display:none;font-size:1px;color:${BRAND_COLORS.background};line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${previewText}
    ${'&nbsp;&zwnj;'.repeat(30)}
  </div>
  
  <!-- Email Wrapper -->
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:${BRAND_COLORS.background};">
    <tr>
      <td align="center" style="padding:40px 20px;">
        
        <!-- Email Container -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" class="mobile-full-width" style="max-width:600px;background-color:${BRAND_COLORS.white};border-radius:16px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td align="center" style="background-color:${BRAND_COLORS.primary};padding:40px 40px 35px;">
              
              <!-- Logo Icon -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:rgba(255,255,255,0.2);border-radius:14px;padding:12px;margin-bottom:16px;">
                    <!--[if mso]>
                    <v:oval style="width:32px;height:32px;" fillcolor="white" stroked="f">
                      <v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:true">
                        <center style="font-size:20px;color:${BRAND_COLORS.primary};">&#128065;</center>
                      </v:textbox>
                    </v:oval>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <img src="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0iTTEyIDQuNUM3IDQuNSAyLjczIDcuNjEgMSAxMmMxLjczIDQuMzkgNiA3LjUgMTEgNy41czkuMjctMy4xMSAxMS03LjVjLTEuNzMtNC4zOS02LTcuNS0xMS03LjV6TTEyIDE3Yy0yLjc2IDAtNS0yLjI0LTUtNXMyLjI0LTUgNS01IDUgMi4yNCA1IDUtMi4yNCA1LTUgNXptMC04Yy0xLjY2IDAtMyAxLjM0LTMgM3MxLjM0IDMgMyAzIDMtMS4zNCAzLTMtMS4zNC0zLTMtM3oiIGZpbGw9IndoaXRlIi8+PC9zdmc+" alt="" width="32" height="32" style="display:block;" />
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>
              
              <h1 style="margin:16px 0 0;font-size:28px;font-weight:700;color:${BRAND_COLORS.white};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Azul Vision</h1>
              <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.85);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">AI Operations Hub</p>
              
            </td>
          </tr>
          
          <!-- Content -->
          ${content}
          
          <!-- Footer -->
          <tr>
            <td style="background-color:${BRAND_COLORS.background};padding:32px 40px;text-align:center;border-top:1px solid ${BRAND_COLORS.border};" class="mobile-padding">
              <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:${BRAND_COLORS.primary};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Azul Vision</p>
              <p style="margin:0 0 4px;font-size:13px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Excellence in Ophthalmology Care</p>
              <p style="margin:16px 0 0;font-size:12px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                This email was sent by Azul Vision AI Operations Hub.<br/>
                If you have questions, please contact your administrator.
              </p>
              <p style="margin:20px 0 0;font-size:11px;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                &copy; ${new Date().getFullYear()} Azul Vision. All rights reserved.
              </p>
            </td>
          </tr>
          
        </table>
        
      </td>
    </tr>
  </table>
  
</body>
</html>
  `;
}

function getFeatureList(items: string[]): string {
  let html = '<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:24px 0;">';
  for (const item of items) {
    html += `
      <tr>
        <td valign="top" style="padding-right:12px;padding-bottom:12px;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" valign="middle" style="width:20px;height:20px;background-color:${BRAND_COLORS.success};border-radius:50%;">
                <span style="color:${BRAND_COLORS.white};font-size:12px;font-weight:bold;">&#10003;</span>
              </td>
            </tr>
          </table>
        </td>
        <td valign="middle" style="font-size:15px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding-bottom:12px;">
          ${item}
        </td>
      </tr>
    `;
  }
  html += '</table>';
  return html;
}

function getRoleBadge(role: string): string {
  return `<span style="display:inline-block;padding:6px 14px;background-color:${BRAND_COLORS.primary};color:${BRAND_COLORS.white};border-radius:20px;font-size:14px;font-weight:600;text-transform:capitalize;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${role}</span>`;
}

function getInfoBox(message: string, type: 'warning' | 'success' = 'warning'): string {
  const bgColor = type === 'warning' ? '#fef3c7' : '#d1fae5';
  const borderColor = type === 'warning' ? BRAND_COLORS.warning : BRAND_COLORS.success;
  const textColor = type === 'warning' ? '#92400e' : '#065f46';
  
  return `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0;">
      <tr>
        <td style="background-color:${bgColor};border-left:4px solid ${borderColor};border-radius:0 8px 8px 0;padding:16px 20px;">
          <p style="margin:0;font-size:14px;color:${textColor};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${message}</p>
        </td>
      </tr>
    </table>
  `;
}

function getDivider(): string {
  return `
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
      <tr>
        <td style="height:1px;background-color:${BRAND_COLORS.border};"></td>
      </tr>
    </table>
  `;
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  try {
    const transport = getTransporter();
    
    await transport.sendMail({
      from: FROM_ADDRESS,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
    });
    
    console.log(`[EMAIL] Sent email to ${options.to}: ${options.subject}`);
    return true;
  } catch (error) {
    console.error(`[EMAIL] Failed to send email to ${options.to}:`, error);
    return false;
  }
}

export async function sendInviteEmail(
  email: string,
  inviteToken: string,
  inviterName: string,
  role: string
): Promise<boolean> {
  const baseUrl = process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000';
  const inviteUrl = `https://${baseUrl}/accept-invite?token=${inviteToken}`;
  
  const features = [
    'AI-powered voice agent management',
    'Real-time call monitoring and analytics',
    'Campaign management tools',
    'Comprehensive reporting dashboard',
  ];
  
  const content = `
    <tr>
      <td style="padding:40px;" class="mobile-padding">
        <h2 style="margin:0 0 20px;font-size:24px;font-weight:600;color:${BRAND_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">You've Been Invited!</h2>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Hello,</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><strong style="color:${BRAND_COLORS.text};">${inviterName}</strong> has invited you to join the Azul Vision AI Operations Hub team.</p>
        
        <p style="margin:24px 0 8px;font-size:16px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your assigned role:</p>
        <p style="margin:0 0 24px;">${getRoleBadge(role)}</p>
        
        <p style="margin:0 0 8px;font-size:16px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">As a member, you'll have access to:</p>
        ${getFeatureList(features)}
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
          <tr>
            <td align="center">
              ${getButton('Accept Invitation', inviteUrl)}
            </td>
          </tr>
        </table>
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:${BRAND_COLORS.background};border-radius:8px;margin:24px 0;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px;font-size:13px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">If the button doesn't work, copy and paste this link:</p>
              <a href="${inviteUrl}" style="font-size:13px;color:${BRAND_COLORS.primary};word-break:break-all;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${inviteUrl}</a>
            </td>
          </tr>
        </table>
        
        ${getInfoBox('<strong>Important:</strong> This invitation will expire in 7 days. Please complete your registration before then.')}
      </td>
    </tr>
  `;
  
  const html = getBaseTemplate(content, `${inviterName} has invited you to join Azul Vision AI Operations Hub`);
  
  return sendEmail({
    to: email,
    subject: `You're Invited to Join Azul Vision AI Operations Hub`,
    html,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  resetToken: string,
  userName: string
): Promise<boolean> {
  const baseUrl = process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000';
  const resetUrl = `https://${baseUrl}/reset-password?token=${resetToken}`;
  
  const content = `
    <tr>
      <td style="padding:40px;" class="mobile-padding">
        <h2 style="margin:0 0 20px;font-size:24px;font-weight:600;color:${BRAND_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Password Reset Request</h2>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Hello ${userName || 'there'},</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">We received a request to reset the password for your Azul Vision AI Operations Hub account.</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">If you made this request, click the button below to create a new password:</p>
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
          <tr>
            <td align="center">
              ${getButton('Reset My Password', resetUrl)}
            </td>
          </tr>
        </table>
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:${BRAND_COLORS.background};border-radius:8px;margin:24px 0;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px;font-size:13px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">If the button doesn't work, copy and paste this link:</p>
              <a href="${resetUrl}" style="font-size:13px;color:${BRAND_COLORS.primary};word-break:break-all;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${resetUrl}</a>
            </td>
          </tr>
        </table>
        
        ${getInfoBox('<strong>Security Notice:</strong> This link will expire in 1 hour for your protection. If you didn\'t request this password reset, you can safely ignore this email.')}
        
        ${getDivider()}
        
        <p style="margin:0;font-size:14px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">If you're having trouble or didn't request this reset, please contact your system administrator immediately.</p>
      </td>
    </tr>
  `;
  
  const html = getBaseTemplate(content, `Reset your Azul Vision password - this link expires in 1 hour`);
  
  return sendEmail({
    to: email,
    subject: 'Reset Your Password - Azul Vision',
    html,
  });
}

export async function sendWelcomeEmail(
  email: string,
  userName: string
): Promise<boolean> {
  const baseUrl = process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000';
  const loginUrl = `https://${baseUrl}/login`;
  
  const features = [
    'Monitor and manage AI voice agents in real-time',
    'Track call logs and view detailed transcripts',
    'Create and manage outreach campaigns',
    'Access the callback queue and scheduling tools',
    'View comprehensive analytics and reports',
  ];
  
  const content = `
    <tr>
      <td style="padding:40px;" class="mobile-padding">
        <h2 style="margin:0 0 20px;font-size:24px;font-weight:600;color:${BRAND_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Welcome to Azul Vision!</h2>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Hello ${userName},</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Congratulations! Your account has been successfully created. You're now part of the Azul Vision AI Operations Hub team.</p>
        
        ${getInfoBox('<strong>Your account is ready!</strong> You can now log in and start exploring the platform.', 'success')}
        
        <p style="margin:24px 0 8px;font-size:16px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Here's what you can do with your new account:</p>
        ${getFeatureList(features)}
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
          <tr>
            <td align="center">
              ${getButton('Login to Dashboard', loginUrl)}
            </td>
          </tr>
        </table>
        
        ${getDivider()}
        
        <p style="margin:0;font-size:14px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Need help getting started? Reach out to your administrator for guidance on using the platform effectively.</p>
      </td>
    </tr>
  `;
  
  const html = getBaseTemplate(content, `Welcome to Azul Vision! Your account is ready.`);
  
  return sendEmail({
    to: email,
    subject: 'Welcome to Azul Vision AI Operations Hub',
    html,
  });
}

export async function sendPasswordChangedEmail(
  email: string,
  userName: string
): Promise<boolean> {
  const baseUrl = process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000';
  const loginUrl = `https://${baseUrl}/login`;
  
  const content = `
    <tr>
      <td style="padding:40px;" class="mobile-padding">
        <h2 style="margin:0 0 20px;font-size:24px;font-weight:600;color:${BRAND_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Password Changed Successfully</h2>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Hello ${userName || 'there'},</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">This is a confirmation that the password for your Azul Vision AI Operations Hub account has been successfully changed.</p>
        
        ${getInfoBox('<strong>Password Updated:</strong> Your new password is now active. You can use it to log in to your account.', 'success')}
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
          <tr>
            <td align="center">
              ${getButton('Login to Dashboard', loginUrl)}
            </td>
          </tr>
        </table>
        
        ${getDivider()}
        
        ${getInfoBox('<strong>Didn\'t make this change?</strong> If you did not change your password, please contact your administrator immediately. Someone may have accessed your account without permission.')}
      </td>
    </tr>
  `;
  
  const html = getBaseTemplate(content, `Your Azul Vision password has been changed successfully`);
  
  return sendEmail({
    to: email,
    subject: 'Password Changed - Azul Vision',
    html,
  });
}

export async function sendAccountDeactivatedEmail(
  email: string,
  userName: string
): Promise<boolean> {
  const content = `
    <tr>
      <td style="padding:40px;" class="mobile-padding">
        <h2 style="margin:0 0 20px;font-size:24px;font-weight:600;color:${BRAND_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Account Deactivated</h2>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Hello ${userName || 'there'},</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your Azul Vision AI Operations Hub account has been deactivated by an administrator.</p>
        
        <p style="margin:24px 0 8px;font-size:16px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">This means you will no longer be able to:</p>
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:16px 0;opacity:0.7;">
          <tr>
            <td style="padding:8px 0;font-size:15px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">&#8226; Log in to the Operations Hub</td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:15px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">&#8226; Access call logs and analytics</td>
          </tr>
          <tr>
            <td style="padding:8px 0;font-size:15px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">&#8226; Manage voice agents or campaigns</td>
          </tr>
        </table>
        
        ${getInfoBox('<strong>Questions?</strong> If you believe this was done in error or have questions about your account status, please contact your system administrator.')}
      </td>
    </tr>
  `;
  
  const html = getBaseTemplate(content, `Your Azul Vision account has been deactivated`);
  
  return sendEmail({
    to: email,
    subject: 'Account Deactivated - Azul Vision',
    html,
  });
}

export async function sendRoleChangedEmail(
  email: string,
  userName: string,
  newRole: string
): Promise<boolean> {
  const baseUrl = process.env.REPLIT_DOMAINS?.split(',')[0] || 'localhost:5000';
  const loginUrl = `https://${baseUrl}/login`;
  
  const roleDescriptions: Record<string, string> = {
    admin: 'Full access to all features, user management, and system settings',
    manager: 'Access to user invitations, team management, and advanced features',
    user: 'Standard access to the Operations Hub dashboard and tools',
  };
  
  const content = `
    <tr>
      <td style="padding:40px;" class="mobile-padding">
        <h2 style="margin:0 0 20px;font-size:24px;font-weight:600;color:${BRAND_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your Role Has Been Updated</h2>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Hello ${userName || 'there'},</p>
        <p style="margin:0 0 16px;font-size:16px;color:${BRAND_COLORS.textLight};line-height:1.7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your role in the Azul Vision AI Operations Hub has been updated by an administrator.</p>
        
        <p style="margin:24px 0 8px;font-size:16px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your new role:</p>
        <p style="margin:0 0 8px;">${getRoleBadge(newRole)}</p>
        <p style="margin:0 0 24px;font-size:14px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${roleDescriptions[newRole] || 'Access to the Operations Hub'}</p>
        
        ${getInfoBox('<strong>Changes are active:</strong> Your new permissions are now in effect. Log in to see your updated access.', 'success')}
        
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0;">
          <tr>
            <td align="center">
              ${getButton('Login to Dashboard', loginUrl)}
            </td>
          </tr>
        </table>
        
        ${getDivider()}
        
        <p style="margin:0;font-size:14px;color:${BRAND_COLORS.textLight};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">If you have questions about your new role or permissions, please contact your administrator.</p>
      </td>
    </tr>
  `;
  
  const html = getBaseTemplate(content, `Your Azul Vision role has been changed to ${newRole}`);
  
  return sendEmail({
    to: email,
    subject: `Role Updated - Azul Vision`,
    html,
  });
}

export async function verifySmtpConnection(): Promise<boolean> {
  try {
    const transport = getTransporter();
    await transport.verify();
    console.log('[EMAIL] SMTP connection verified successfully');
    return true;
  } catch (error) {
    console.error('[EMAIL] SMTP connection failed:', error);
    return false;
  }
}
