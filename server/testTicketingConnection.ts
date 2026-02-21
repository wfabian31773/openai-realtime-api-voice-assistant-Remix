import "dotenv/config";
import { ticketingApiClient } from "./services/ticketingApiClient";

/**
 * Test script to verify ticketing system integration
 * Run with: npx tsx server/testTicketingConnection.ts
 */

async function testTicketingConnection() {
  console.log("\n=================================================");
  console.log("🧪 TICKETING SYSTEM CONNECTION TEST");
  console.log("=================================================\n");

  // Check environment variables
  console.log("📋 Environment Configuration:");
  console.log(`   TICKETING_SYSTEM_URL: ${process.env.TICKETING_SYSTEM_URL ? '✓ Configured' : '✗ Missing'}`);
  console.log(`   VOICE_AGENT_WEBHOOK_SECRET: ${process.env.VOICE_AGENT_WEBHOOK_SECRET ? '✓ Configured' : '✗ Missing'}`);
  console.log();

  if (!process.env.TICKETING_SYSTEM_URL) {
    console.error("❌ ERROR: TICKETING_SYSTEM_URL not configured");
    process.exit(1);
  }

  console.log(`🌐 Ticketing System URL: ${process.env.TICKETING_SYSTEM_URL}\n`);

  // Create a test ticket
  console.log("📝 Creating test ticket...\n");
  console.log("Test Ticket Details:");
  
  const testTicket = {
    departmentId: 1, // Optical
    requestTypeId: 1,
    requestReasonId: 1,
    patientFirstName: "Test",
    patientLastName: "Patient",
    patientPhone: "+16262229400",
    patientEmail: "test@azulvision.com",
    patientBirthMonth: "03",
    patientBirthDay: "15",
    patientBirthYear: "1985",
    description: "TEST TICKET - Connection verification from Azul Vision AI Operations Hub",
    priority: "medium" as const,
  };

  console.log(`   Patient: ${testTicket.patientFirstName} ${testTicket.patientLastName}`);
  console.log(`   Phone: ${testTicket.patientPhone}`);
  console.log(`   Email: ${testTicket.patientEmail}`);
  console.log(`   Department: ${testTicket.departmentId} (Optical)`);
  console.log(`   Priority: ${testTicket.priority}`);
  console.log(`   Description: ${testTicket.description}`);
  console.log();

  try {
    console.log("🚀 Sending request to external ticketing system...\n");
    
    const response = await ticketingApiClient.createTicket(testTicket);

    console.log("=================================================");
    console.log("📥 RESPONSE FROM TICKETING SYSTEM");
    console.log("=================================================\n");
    console.log(JSON.stringify(response, null, 2));
    console.log();

    if (response.success && response.ticketNumber) {
      console.log("✅ SUCCESS! Ticket created successfully");
      console.log(`   Ticket Number: ${response.ticketNumber}`);
      console.log(`   Ticket ID: ${response.ticketId}`);
      console.log();
      console.log("🎉 Connection to ticketing system is working!");
      console.log("👉 Check your ticketing system to verify the ticket appears there.");
      console.log();
      console.log("=================================================");
      console.log("NEXT STEPS:");
      console.log("=================================================");
      console.log("1. ✅ Verify ticket appears in your external ticketing system");
      console.log(`2. ✅ Look for ticket number: ${response.ticketNumber}`);
      console.log("3. 🔄 Test resolution callback by resolving the ticket");
      console.log("4. 📞 Verify voice agent receives resolution webhook");
      console.log("=================================================\n");
    } else {
      console.log("❌ FAILED - Ticket creation failed");
      console.log(`   Error: ${response.error || 'Unknown error'}`);
      console.log();
      console.log("Troubleshooting:");
      console.log("- Verify TICKETING_SYSTEM_URL is correct");
      console.log("- Verify TICKETING_API_KEY is valid");
      console.log("- Check external ticketing system logs for errors");
      console.log();
    }
  } catch (error) {
    console.error("\n❌ ERROR during ticket creation:");
    console.error(error);
    console.log();
    console.log("Possible issues:");
    console.log("- External ticketing system is unreachable");
    console.log("- API key is invalid");
    console.log("- Network connectivity issues");
    console.log("- External system endpoint doesn't exist");
    console.log();
    process.exit(1);
  }
}

// Run the test
testTicketingConnection();
