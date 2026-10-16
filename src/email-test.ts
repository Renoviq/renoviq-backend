import { sendEmail } from "./email";

async function testSendEmail() {
  try {
    const to = process.env.SMTP_USER || "your-email@example.com";
    const subject = "Test Email from Nodemailer";
    const text = "This is a test email sent from the Nodemailer test script.";
    await sendEmail(to, subject, text);
    console.log("Test email sent successfully.");
  } catch (error) {
    console.error("Error sending test email:", error);
  }
}

testSendEmail();
