import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

  // Email Content Generation
  export function generateVerificationEmailContent({
    firstName,
    lastName,
    otp,
    isResend = false,
    primaryColor = "#16a34a",
  }: {
    firstName: string;
    lastName: string;
    otp: string;
    isResend?: boolean;
    primaryColor?: string;
  }) {
    const logoSvg = `
    <svg width="200" height="60" viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="greenGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:${primaryColor};stop-opacity:1" />
          <stop offset="100%" style="stop-color:#22c55e;stop-opacity:1" />
        </linearGradient>
      </defs>
      <text x="10" y="35" font-family="Arial, sans-serif" font-size="35" font-weight="bold" fill="url(#greenGradient)">Renoviq</text>
      <text x="140" y="35" font-family="Arial, sans-serif" font-size="35" font-weight="bold" fill="white" stroke="${primaryColor}" stroke-width="1">AI</text>
      <rect x="0" y="0" width="200" height="60" fill="none" stroke="${primaryColor}" stroke-width="2" rx="8"/>
    </svg>
  `;
    const smallLogoSvg = `
    <svg width="120" height="36" viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="greenGradientSmall" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:${primaryColor};stop-opacity:1" />
          <stop offset="100%" style="stop-color:#22c55e;stop-opacity:1" />
        </linearGradient>
      </defs>
      <text x="6" y="22" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="url(#greenGradientSmall)">Renoviq</text>
      <text x="84" y="22" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#666" stroke="${primaryColor}" stroke-width="0.5">AI</text>
    </svg>
  `;

    const introText = isResend
      ? "You requested to resend your verification code. Please use the verification code below to verify your email address:"
      : "Thank you for joining RenoviqAI! To complete your registration and start transforming your spaces with AI-powered renovation suggestions, please verify your email address using the verification code below:";

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Email Verification - RenoviqAI</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; line-height: 1.6;">
      <div style="max-width: 600px; margin: 40px auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden;">
        <div style="background: linear-gradient(135deg, ${primaryColor} 0%, #22c55e 100%); padding: 30px 40px; text-align: center;">
          ${logoSvg}
          <h1 style="color: white; margin: 20px 0 10px 0; font-size: 24px; font-weight: 600;">Welcome to RenoviqAI!</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 16px;">Your AI-Powered Room Renovation Partner</p>
        </div>
        <div style="padding: 40px;">
          <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 22px; font-weight: 600;">Verify Your Email Address</h2>
          <p style="color: #4b5563; margin: 0 0 20px 0; font-size: 16px;">
            Hello <strong>${firstName} ${lastName}</strong>,
          </p>
          <p style="color: #4b5563; margin: 0 0 30px 0; font-size: 16px;">
            ${introText}
          </p>
          <div style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 2px solid ${primaryColor}; border-radius: 12px; padding: 30px; text-align: center; margin: 30px 0;">
            <p style="color: #374151; margin: 0 0 15px 0; font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
            <div style="font-size: 36px; font-weight: bold; color: ${primaryColor}; letter-spacing: 8px; font-family: 'Courier New', monospace; margin: 10px 0;">${otp}</div>
            <p style="color: #6b7280; margin: 15px 0 0 0; font-size: 14px;">Valid for 10 minutes only</p>
          </div>
          <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px 20px; margin: 25px 0; border-radius: 4px;">
            <p style="color: #92400e; margin: 0; font-size: 14px;">
              <strong>Security Notice:</strong> This code is confidential. Never share it with anyone. RenoviqAI will never ask for your verification code via phone or email.
            </p>
          </div>
          ${
            isResend
              ? `<p style="color: #4b5563; margin: 25px 0 0 0; font-size: 16px;">
                  If you didn't create an account with RenoviqAI, please ignore this email or contact our support team if you have concerns.
                </p>`
              : `<p style="color: #4b5563; margin: 25px 0 0 0; font-size: 16px;">
                  Once verified, you'll be able to:
                </p>
                <ul style="color: #4b5563; margin: 10px 0 25px 20px; font-size: 16px;">
                  <li style="margin: 8px 0;">Upload room photos for AI-powered renovation suggestions</li>
                  <li style="margin: 8px 0;">Access our extensive design library and styles</li>
                  <li style="margin: 8px 0;">Save and manage your renovation projects</li>
                  <li style="margin: 8px 0;">Get personalized design recommendations</li>
                </ul>
                <p style="color: #6b7280; margin: 25px 0 0 0; font-size: 14px;">
                  If you didn't create an account with RenoviqAI, please ignore this email or contact our support team if you have concerns.
                </p>`
          }
        </div>
        <div style="background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 30px 40px;">
          <div style="text-align: center; margin-bottom: 20px;">
            ${smallLogoSvg}
          </div>
          <div style="text-align: center; color: #6b7280; font-size: 14px; line-height: 1.5;">
            <p style="margin: 0 0 10px 0; font-weight: 600; color: #374151;">RenoviqAI Technologies Inc.</p>
            <p style="margin: 0 0 5px 0;">📍 Sector H-10, ISB</p>
            <p style="margin: 0 0 5px 0;">International Islamic University, ISB</p>
            <p style="margin: 0 0 15px 0;">📞 +92 344 1886535 | ✉️ support@renoviqai.com</p>
            <div style="border-top: 1px solid #e5e7eb; padding-top: 15px; margin-top: 15px;">
              <p style="margin: 0 0 5px 0;">© 2025 RenoviqAI Technologies Inc. All rights reserved.</p>
              <p style="margin: 0; font-size: 12px;">
                <a href="#" style="color: ${primaryColor}; text-decoration: none; margin: 0 10px;">Privacy Policy</a> |
                <a href="#" style="color: ${primaryColor}; text-decoration: none; margin: 0 10px;">Terms of Service</a> |
                <a href="#" style="color: ${primaryColor}; text-decoration: none; margin: 0 10px;">Contact Us</a>
              </p>
            </div>
          </div>
        </div>
      </div>
      <div style="text-align: center; margin: 20px 0; color: #9ca3af; font-size: 12px;">
        <p>If you're having trouble viewing this email, please check your spam folder or contact support.</p>
      </div>
    </body>
    </html>
  `;

    const plainTextContent = `
    RenoviqAI - Email Verification

    Hello ${firstName} ${lastName},

    ${
      isResend
        ? "You requested to resend your verification code. Please use the following verification code to verify your email address:"
        : "Thank you for joining RenoviqAI! Please use the following verification code to complete your registration:"
    }

    Verification Code: ${otp}

    This code is valid for 10 minutes only.

    If you didn't create an account with RenoviqAI, please ignore this email.

    Best regards,
    The RenoviqAI Team

    RenoviqAI Technologies Inc.
    📍 Sector H-10, ISB
    International Islamic University, ISB
    Phone: +92 344 1886535
    Email: support@renoviqai.com

    © 2025 RenoviqAI Technologies Inc. All rights reserved.
  `;

    return { htmlContent, plainTextContent };
  }


export async function sendEmail(to: string, subject: string, text: string, html?: string) {
  const mailOptions = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: " + info.response);
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
}
