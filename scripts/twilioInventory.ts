import twilio from 'twilio';
import * as fs from 'fs';

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    process.exit(1);
  }

  const client = twilio(accountSid, authToken);
  const report: any = {
    accountSid,
    generatedAt: new Date().toISOString(),
    phoneNumbers: [],
    twimlApps: [],
    messagingServices: [],
    sipDomains: [],
    sipTrunks: [],
    webhookMap: {} as Record<string, string[]>,
  };

  console.log('=== Twilio Account Inventory ===\n');

  console.log('1. Fetching phone numbers...');
  try {
    const numbers = await client.incomingPhoneNumbers.list();
    for (const num of numbers) {
      const entry = {
        sid: num.sid,
        phoneNumber: num.phoneNumber,
        friendlyName: num.friendlyName,
        voiceUrl: num.voiceUrl || null,
        voiceMethod: num.voiceMethod || null,
        voiceFallbackUrl: num.voiceFallbackUrl || null,
        voiceApplicationSid: num.voiceApplicationSid || null,
        smsUrl: num.smsUrl || null,
        smsMethod: num.smsMethod || null,
        smsFallbackUrl: num.smsFallbackUrl || null,
        smsApplicationSid: num.smsApplicationSid || null,
        statusCallback: num.statusCallback || null,
        statusCallbackMethod: num.statusCallbackMethod || null,
        trunkSid: num.trunkSid || null,
        capabilities: {
          voice: (num.capabilities as any)?.voice || false,
          sms: (num.capabilities as any)?.sms || false,
          mms: (num.capabilities as any)?.mms || false,
          fax: (num.capabilities as any)?.fax || false,
        },
      };
      report.phoneNumbers.push(entry);

      const urls = [entry.voiceUrl, entry.voiceFallbackUrl, entry.smsUrl, entry.smsFallbackUrl, entry.statusCallback].filter(Boolean);
      for (const url of urls) {
        if (!report.webhookMap[url!]) report.webhookMap[url!] = [];
        report.webhookMap[url!].push(`${num.phoneNumber} (${num.friendlyName})`);
      }
    }
    console.log(`   Found ${numbers.length} phone numbers`);
  } catch (err: any) {
    console.error('   Error fetching phone numbers:', err.message);
  }

  console.log('2. Fetching TwiML apps...');
  try {
    const apps = await client.applications.list();
    for (const app of apps) {
      report.twimlApps.push({
        sid: app.sid,
        friendlyName: app.friendlyName,
        voiceUrl: app.voiceUrl || null,
        voiceMethod: app.voiceMethod || null,
        voiceFallbackUrl: app.voiceFallbackUrl || null,
        smsUrl: app.smsUrl || null,
        smsMethod: app.smsMethod || null,
        smsFallbackUrl: app.smsFallbackUrl || null,
        statusCallback: app.statusCallback || null,
        statusCallbackMethod: app.statusCallbackMethod || null,
      });

      const urls = [app.voiceUrl, app.voiceFallbackUrl, app.smsUrl, app.smsFallbackUrl, app.statusCallback].filter(Boolean);
      for (const url of urls) {
        if (!report.webhookMap[url!]) report.webhookMap[url!] = [];
        report.webhookMap[url!].push(`TwiML App: ${app.friendlyName} (${app.sid})`);
      }
    }
    console.log(`   Found ${apps.length} TwiML apps`);
  } catch (err: any) {
    console.error('   Error fetching TwiML apps:', err.message);
  }

  console.log('3. Fetching messaging services...');
  try {
    const services = await client.messaging.v1.services.list();
    for (const svc of services) {
      const senders: any[] = [];
      try {
        const phoneNumbers = await client.messaging.v1.services(svc.sid).phoneNumbers.list();
        for (const pn of phoneNumbers) {
          senders.push({ type: 'phone', phoneNumber: pn.phoneNumber, sid: pn.sid });
        }
      } catch (_) {}

      report.messagingServices.push({
        sid: svc.sid,
        friendlyName: svc.friendlyName,
        inboundRequestUrl: svc.inboundRequestUrl || null,
        inboundMethod: svc.inboundMethod || null,
        fallbackUrl: svc.fallbackUrl || null,
        statusCallback: svc.statusCallback || null,
        useInboundWebhookOnNumber: svc.useInboundWebhookOnNumber || false,
        senders,
      });
    }
    console.log(`   Found ${services.length} messaging services`);
  } catch (err: any) {
    console.error('   Error fetching messaging services:', err.message);
  }

  console.log('4. Fetching SIP domains...');
  try {
    const domains = await client.sip.domains.list();
    for (const domain of domains) {
      report.sipDomains.push({
        sid: domain.sid,
        domainName: domain.domainName,
        friendlyName: domain.friendlyName,
        voiceUrl: domain.voiceUrl || null,
        voiceMethod: domain.voiceMethod || null,
        voiceFallbackUrl: domain.voiceFallbackUrl || null,
        voiceStatusCallbackUrl: domain.voiceStatusCallbackUrl || null,
        byocTrunkSid: domain.byocTrunkSid || null,
      });
    }
    console.log(`   Found ${domains.length} SIP domains`);
  } catch (err: any) {
    console.error('   Error fetching SIP domains:', err.message);
  }

  console.log('5. Fetching SIP trunks...');
  try {
    const trunks = await client.trunking.v1.trunks.list();
    for (const trunk of trunks) {
      const originationUrls: any[] = [];
      try {
        const origins = await client.trunking.v1.trunks(trunk.sid).originationUrls.list();
        for (const o of origins) {
          originationUrls.push({
            sid: o.sid,
            friendlyName: o.friendlyName,
            sipUrl: o.sipUrl,
            weight: o.weight,
            priority: o.priority,
            enabled: o.enabled,
          });
        }
      } catch (_) {}

      const phoneNumbers: any[] = [];
      try {
        const pns = await client.trunking.v1.trunks(trunk.sid).phoneNumbers.list();
        for (const pn of pns) {
          phoneNumbers.push({
            sid: pn.sid,
            phoneNumber: pn.phoneNumber,
            friendlyName: pn.friendlyName,
          });
        }
      } catch (_) {}

      report.sipTrunks.push({
        sid: trunk.sid,
        friendlyName: trunk.friendlyName,
        domainName: trunk.domainName,
        disasterRecoveryUrl: trunk.disasterRecoveryUrl || null,
        recording: trunk.recording || null,
        originationUrls,
        phoneNumbers,
      });
    }
    console.log(`   Found ${trunks.length} SIP trunks`);
  } catch (err: any) {
    console.error('   Error fetching SIP trunks:', err.message);
  }

  const outputJson = JSON.stringify(report, null, 2);
  fs.writeFileSync('twilio-inventory.json', outputJson);
  console.log('\n✓ Full JSON inventory saved to twilio-inventory.json');

  let markdown = `# Twilio Account Inventory\n\n`;
  markdown += `**Account SID:** ${accountSid}\n`;
  markdown += `**Generated:** ${report.generatedAt}\n\n`;

  markdown += `---\n\n## Phone Numbers (${report.phoneNumbers.length})\n\n`;
  for (const pn of report.phoneNumbers) {
    markdown += `### ${pn.phoneNumber} — ${pn.friendlyName}\n`;
    markdown += `| Config | Value |\n|---|---|\n`;
    markdown += `| SID | \`${pn.sid}\` |\n`;
    markdown += `| Capabilities | Voice: ${pn.capabilities.voice}, SMS: ${pn.capabilities.sms}, MMS: ${pn.capabilities.mms} |\n`;
    if (pn.voiceUrl) markdown += `| Voice URL | ${pn.voiceUrl} |\n`;
    if (pn.voiceApplicationSid) markdown += `| Voice App SID | \`${pn.voiceApplicationSid}\` |\n`;
    if (pn.voiceFallbackUrl) markdown += `| Voice Fallback | ${pn.voiceFallbackUrl} |\n`;
    if (pn.smsUrl) markdown += `| SMS URL | ${pn.smsUrl} |\n`;
    if (pn.smsApplicationSid) markdown += `| SMS App SID | \`${pn.smsApplicationSid}\` |\n`;
    if (pn.statusCallback) markdown += `| Status Callback | ${pn.statusCallback} |\n`;
    if (pn.trunkSid) markdown += `| Trunk SID | \`${pn.trunkSid}\` |\n`;
    markdown += `\n`;
  }

  markdown += `---\n\n## TwiML Apps (${report.twimlApps.length})\n\n`;
  for (const app of report.twimlApps) {
    markdown += `### ${app.friendlyName}\n`;
    markdown += `| Config | Value |\n|---|---|\n`;
    markdown += `| SID | \`${app.sid}\` |\n`;
    if (app.voiceUrl) markdown += `| Voice URL | ${app.voiceUrl} |\n`;
    if (app.voiceFallbackUrl) markdown += `| Voice Fallback | ${app.voiceFallbackUrl} |\n`;
    if (app.smsUrl) markdown += `| SMS URL | ${app.smsUrl} |\n`;
    if (app.statusCallback) markdown += `| Status Callback | ${app.statusCallback} |\n`;
    markdown += `\n`;
  }

  markdown += `---\n\n## Messaging Services (${report.messagingServices.length})\n\n`;
  for (const svc of report.messagingServices) {
    markdown += `### ${svc.friendlyName}\n`;
    markdown += `| Config | Value |\n|---|---|\n`;
    markdown += `| SID | \`${svc.sid}\` |\n`;
    if (svc.inboundRequestUrl) markdown += `| Inbound URL | ${svc.inboundRequestUrl} |\n`;
    if (svc.fallbackUrl) markdown += `| Fallback URL | ${svc.fallbackUrl} |\n`;
    if (svc.statusCallback) markdown += `| Status Callback | ${svc.statusCallback} |\n`;
    if (svc.senders.length > 0) {
      markdown += `| Senders | ${svc.senders.map((s: any) => s.phoneNumber).join(', ')} |\n`;
    }
    markdown += `\n`;
  }

  markdown += `---\n\n## SIP Domains (${report.sipDomains.length})\n\n`;
  for (const d of report.sipDomains) {
    markdown += `### ${d.domainName} — ${d.friendlyName}\n`;
    markdown += `| Config | Value |\n|---|---|\n`;
    markdown += `| SID | \`${d.sid}\` |\n`;
    if (d.voiceUrl) markdown += `| Voice URL | ${d.voiceUrl} |\n`;
    if (d.voiceFallbackUrl) markdown += `| Voice Fallback | ${d.voiceFallbackUrl} |\n`;
    if (d.voiceStatusCallbackUrl) markdown += `| Voice Status Callback | ${d.voiceStatusCallbackUrl} |\n`;
    if (d.byocTrunkSid) markdown += `| BYOC Trunk SID | \`${d.byocTrunkSid}\` |\n`;
    markdown += `\n`;
  }

  markdown += `---\n\n## SIP Trunks (${report.sipTrunks.length})\n\n`;
  for (const t of report.sipTrunks) {
    markdown += `### ${t.friendlyName}\n`;
    markdown += `| Config | Value |\n|---|---|\n`;
    markdown += `| SID | \`${t.sid}\` |\n`;
    if (t.domainName) markdown += `| Domain | ${t.domainName} |\n`;
    if (t.disasterRecoveryUrl) markdown += `| DR URL | ${t.disasterRecoveryUrl} |\n`;
    if (t.originationUrls.length > 0) {
      markdown += `\n**Origination URLs:**\n`;
      for (const o of t.originationUrls) {
        markdown += `- ${o.friendlyName}: \`${o.sipUrl}\` (priority: ${o.priority}, weight: ${o.weight}, enabled: ${o.enabled})\n`;
      }
    }
    if (t.phoneNumbers.length > 0) {
      markdown += `\n**Associated Phone Numbers:**\n`;
      for (const pn of t.phoneNumbers) {
        markdown += `- ${pn.phoneNumber} (${pn.friendlyName})\n`;
      }
    }
    markdown += `\n`;
  }

  markdown += `---\n\n## Webhook URL Mapping\n\n`;
  markdown += `This shows which resources share the same webhook URLs (potential overlap):\n\n`;
  const sortedUrls = Object.entries(report.webhookMap).sort((a, b) => b[1].length - a[1].length);
  for (const [url, resources] of sortedUrls) {
    markdown += `### ${url}\n`;
    for (const r of resources as string[]) {
      markdown += `- ${r}\n`;
    }
    if ((resources as string[]).length > 1) {
      markdown += `\n**⚠️ SHARED WEBHOOK** — ${(resources as string[]).length} resources point here\n`;
    }
    markdown += `\n`;
  }

  const phoneToTrunk: Record<string, string[]> = {};
  for (const t of report.sipTrunks) {
    for (const pn of t.phoneNumbers) {
      if (!phoneToTrunk[pn.phoneNumber]) phoneToTrunk[pn.phoneNumber] = [];
      phoneToTrunk[pn.phoneNumber].push(`${t.friendlyName} (${t.sid})`);
    }
  }

  const phoneToMsgSvc: Record<string, string[]> = {};
  for (const svc of report.messagingServices) {
    for (const s of svc.senders) {
      if (!phoneToMsgSvc[s.phoneNumber]) phoneToMsgSvc[s.phoneNumber] = [];
      phoneToMsgSvc[s.phoneNumber].push(`${svc.friendlyName} (${svc.sid})`);
    }
  }

  markdown += `---\n\n## Overlap Analysis\n\n`;

  const multiTrunk = Object.entries(phoneToTrunk).filter(([_, trunks]) => trunks.length > 1);
  if (multiTrunk.length > 0) {
    markdown += `### ⚠️ Phone Numbers on Multiple SIP Trunks\n`;
    for (const [pn, trunks] of multiTrunk) {
      markdown += `- **${pn}**: ${trunks.join(', ')}\n`;
    }
    markdown += `\n`;
  }

  const multiUse: string[] = [];
  for (const pn of report.phoneNumbers) {
    const uses: string[] = [];
    if (pn.voiceUrl || pn.voiceApplicationSid) uses.push('Voice');
    if (pn.smsUrl || pn.smsApplicationSid) uses.push('SMS');
    if (pn.trunkSid) uses.push(`SIP Trunk (${pn.trunkSid})`);
    if (phoneToMsgSvc[pn.phoneNumber]) uses.push(`Messaging Service (${phoneToMsgSvc[pn.phoneNumber].join(', ')})`);
    if (uses.length > 1) {
      multiUse.push(`- **${pn.phoneNumber}** (${pn.friendlyName}): ${uses.join(' + ')}`);
    }
  }
  if (multiUse.length > 0) {
    markdown += `### Phone Numbers with Multiple Configurations\n`;
    markdown += multiUse.join('\n') + '\n\n';
  }

  const trunkPhones = new Set(Object.keys(phoneToTrunk));
  const unassignedTrunkNumbers = report.phoneNumbers.filter(
    (pn: any) => pn.trunkSid && !trunkPhones.has(pn.phoneNumber)
  );
  if (unassignedTrunkNumbers.length > 0) {
    markdown += `### Phone Numbers Referencing Trunks but Not Listed in Trunk\n`;
    for (const pn of unassignedTrunkNumbers) {
      markdown += `- **${pn.phoneNumber}**: trunk SID \`${pn.trunkSid}\`\n`;
    }
    markdown += `\n`;
  }

  if (multiTrunk.length === 0 && multiUse.length === 0 && unassignedTrunkNumbers.length === 0) {
    markdown += `✅ No significant overlaps detected.\n\n`;
  }

  fs.writeFileSync('twilio-inventory.md', markdown);
  console.log('✓ Readable report saved to twilio-inventory.md');
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
