// Seed database with Fantasy Football test campaign and contacts
// Run with: npx tsx server/seedFantasyFootballData.ts

import { db } from "./db";
import { agents, campaigns, campaignContacts } from "../shared/schema";
import { eq } from "drizzle-orm";

async function seedFantasyFootballData() {
  console.log("🏈 Seeding Fantasy Football test campaign...\n");

  try {
    // Get the fantasy football agent
    const [fantasyAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.slug, "fantasy-football"))
      .limit(1);

    if (!fantasyAgent) {
      console.error("❌ Fantasy Football agent not found. Run seedAgents.ts first!");
      process.exit(1);
    }

    console.log(`✓ Found Fantasy Football agent: ${fantasyAgent.name}`);

    // Create test campaign
    const [campaign] = await db.insert(campaigns).values({
      name: "Fantasy Football Test Campaign",
      description: "Test campaign for fantasy football AI advisor calls",
      agentId: fantasyAgent.id,
      campaignType: "call", // Voice calls only
      status: "running", // Ready to test immediately
    }).returning();

    console.log(`✓ Created campaign: ${campaign.name} (ID: ${campaign.id})\n`);

    // Create test contacts
    const testContacts = [
      {
        campaignId: campaign.id,
        firstName: "Wayne",
        lastName: "Fabian",
        phoneNumber: "+16262229400", // Your number
        email: "fabianwayne1@gmail.com",
        metadata: {
          favoriteTeam: "Chiefs",
          leagueName: "The League",
          currentRank: 3,
        },
        status: "pending",
      },
      {
        campaignId: campaign.id,
        firstName: "John",
        lastName: "Smith",
        phoneNumber: "+15551234567", // Test number
        metadata: {
          favoriteTeam: "Bills",
          leagueName: "Winners Only",
          currentRank: 1,
        },
        status: "pending",
      },
      {
        campaignId: campaign.id,
        firstName: "Mike",
        lastName: "Johnson",
        phoneNumber: "+15559876543", // Test number
        metadata: {
          favoriteTeam: "Cowboys",
          leagueName: "Sunday Funday",
          currentRank: 7,
        },
        status: "pending",
      },
    ];

    const contacts = await db
      .insert(campaignContacts)
      .values(testContacts)
      .returning();

    console.log(`✓ Created ${contacts.length} test contacts:`);
    contacts.forEach((contact, i) => {
      console.log(`  ${i + 1}. ${contact.firstName} ${contact.lastName} (${contact.phoneNumber})`);
    });
    console.log();

    console.log("🎉 Fantasy Football test data seeded successfully!\n");
    console.log("Next steps:");
    console.log("1. Sign in to the dashboard");
    console.log("2. Navigate to 'Agents' page");
    console.log("3. Click 'Test' on the Fantasy Football Advisor agent");
    console.log("4. Select a contact and make a test call");
    console.log();
    console.log(`Campaign ID: ${campaign.id}`);
    console.log(`Contact Count: ${contacts.length}`);
    console.log();
  } catch (error) {
    console.error("❌ Error seeding fantasy football data:", error);
    throw error;
  }
}

// Run if executed directly
if (require.main === module) {
  seedFantasyFootballData()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { seedFantasyFootballData };
