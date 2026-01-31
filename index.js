const { App } = require('@slack/bolt');
const jsforce = require('jsforce');
require('dotenv').config();

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
});

const CONFIG = {
    licenseRequestChannel: process.env.LICENSE_REQUEST_CHANNEL || 'C06JLLX47UK',
    customerTagUser: process.env.CUSTOMER_TAG_USER || 'U04SEQE79FE',
    sfInstanceUrl: process.env.SF_INSTANCE_URL || 'https://chilipiper.lightning.force.com',
    gongResellerAccountName: 'Gong - Reseller Account',
    gongResellerAccountId: process.env.GONG_RESELLER_ACCOUNT_ID || null,
};

let sfConnection = null;

async function initSalesforce() {
    try {
          const clientId = process.env.SF_CLIENT_ID;
          const clientSecret = process.env.SF_CLIENT_SECRET;
          const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

      const tokenResponse = await fetch(`${loginUrl}/services/oauth2/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                        grant_type: 'client_credentials',
                        client_id: clientId,
                        client_secret: clientSecret,
              }),
      });

      if (!tokenResponse.ok) {
              const errorText = await tokenResponse.text();
              throw new Error(`OAuth failed: ${tokenResponse.status} - ${errorText}`);
      }

      const tokenData = await tokenResponse.json();
          sfConnection = new jsforce.Connection({
                  instanceUrl: tokenData.instance_url,
                  accessToken: tokenData.access_token,
          });

      console.log('Connected to Salesforce');
          if (!CONFIG.gongResellerAccountId) await cacheGongResellerAccountId();
          return true;
    } catch (error) {
          console.error('Salesforce connection failed:', error.message);
          return false;
    }
}

async function cacheGongResellerAccountId() {
    try {
          const result = await sfConnection.query(
                  `SELECT Id, Name FROM Account WHERE Name = '${CONFIG.gongResellerAccountName}' LIMIT 1`
                );
          if (result.records.length > 0) {
                  CONFIG.gongResellerAccountId = result.records[0].Id;
                  console.log(`Cached Gong Reseller Account ID: ${CONFIG.gongResellerAccountId}`);
          }
    } catch (error) {
          console.error('Error caching Gong Reseller Account ID:', error.message);
    }
}

function extractCustomerAdminEmail(text) {
    const emailPattern = /Customer Admin:.*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
    const match = text.match(emailPattern);
    if (match) return match[1].toLowerCase();

  const lines = text.split('\n');
    for (const line of lines) {
          if (line.toLowerCase().includes('customer admin')) {
                  const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                  if (emailMatch) return emailMatch[1].toLowerCase();
          }
    }
    return null;
}

function extractCustomerName(text) {
    const pattern = /Customer Name:\s*(.+)/i;
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}

async function findContactByEmail(email) {
    try {
          const result = await sfConnection.query(
                  `SELECT Id, Name, Email, AccountId, Account.Name, Account.Type FROM Contact WHERE Email = '${email}' LIMIT 1`
                );
          return result.records.length > 0 ? result.records[0] : null;
    } catch (error) {
          console.error('Error searching for contact:', error.message);
          return null;
    }
}

async function getAccountById(accountId) {
    try {
          const result = await sfConnection.query(
                  `SELECT Id, Name, Type FROM Account WHERE Id = '${accountId}' LIMIT 1`
                );
          return result.records.length > 0 ? result.records[0] : null;
    } catch (error) {
          console.error('Error fetching account:', error.message);
          return null;
    }
}

async function createOpportunity(contact, account) {
    try {
          const closeDate = new Date();
          closeDate.setDate(closeDate.getDate() + 30);
          const closeDateStr = closeDate.toISOString().split('T')[0];
          const oppName = `${account.Name} - Inbound`;

      const opportunityData = {
              Name: oppName,
              AccountId: account.Id,
              StageName: 'Demo',
              CloseDate: closeDateStr,
              Type: 'Inbound',
              LeadSource: 'Partner',
      };

      if (CONFIG.gongResellerAccountId) {
              opportunityData.Billing_Account__c = CONFIG.gongResellerAccountId;
      }

      const result = await sfConnection.sobject('Opportunity').create(opportunityData);

      if (result.success) {
              return {
                        id: result.id,
                        name: oppName,
                        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
              };
      }
          return null;
    } catch (error) {
          console.error('Error creating opportunity:', error.message);
          if (error.message.includes('Billing_Account__c')) {
                  return await createOpportunityWithoutBilling(contact, account);
          }
          return null;
    }
}

async function createOpportunityWithoutBilling(contact, account) {
    try {
          const closeDate = new Date();
          closeDate.setDate(closeDate.getDate() + 30);
          const closeDateStr = closeDate.toISOString().split('T')[0];
          const oppName = `${account.Name} - Inbound`;

      const result = await sfConnection.sobject('Opportunity').create({
              Name: oppName,
              AccountId: account.Id,
              StageName: 'Demo',
              CloseDate: closeDateStr,
              Type: 'Inbound',
              LeadSource: 'Partner',
      });

      if (result.success) {
              return {
                        id: result.id,
                        name: oppName,
                        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
                        note: 'Billing Account was not set - please add manually',
              };
      }
          return null;
    } catch (error) {
          console.error('Error creating opportunity (fallback):', error.message);
          return null;
    }
}

function buildSalesforceUrls(contact, account) {
    return {
          contactUrl: `${CONFIG.sfInstanceUrl}/lightning/r/Contact/${contact.Id}/view`,
          accountUrl: `${CONFIG.sfInstanceUrl}/lightning/r/Account/${account.Id}/view`,
    };
}

app.message(async ({ message, client, logger }) => {
    try {
          if (message.subtype === 'message_changed') return;
          if (message.channel !== CONFIG.licenseRequestChannel) return;

      const text = message.text || '';
          if (!text.includes('New ChiliPiper License Request Submitted!')) return;

      logger.info('New ChiliPiper License Request detected!');

      try {
              await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'eyes' });
      } catch (e) {}

      const customerEmail = extractCustomerAdminEmail(text);
          const customerName = extractCustomerName(text);

      if (!customerEmail) {
              await postThreadReply(client, message, 'Could not extract customer admin email. Please process manually.');
              return;
      }

      if (!sfConnection) {
              const connected = await initSalesforce();
              if (!connected) {
                        await postThreadReply(client, message, 'Could not connect to Salesforce. Please process manually.');
                        return;
              }
      }

      const contact = await findContactByEmail(customerEmail);
          if (!contact) {
                  await postThreadReply(client, message, `Contact not found for: ${customerEmail}\nCustomer Name: ${customerName || 'Unknown'}\nPlease create manually.`);
                  return;
          }

      const account = contact.Account || await getAccountById(contact.AccountId);
          if (!account) {
                  await postThreadReply(client, message, `Could not find account for contact: ${contact.Name}`);
                  return;
          }

      const accountType = account.Type || 'Unknown';
          const urls = buildSalesforceUrls(contact, account);

      if (accountType.toLowerCase() === 'prospect') {
              const opportunity = await createOpportunity(contact, account);
              if (opportunity) {
                        try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'white_check_mark' }); } catch (e) {}
                        let replyText = `*Opportunity Created!*\n\n*Account:* <${urls.accountUrl}|${account.Name}>\n*Account Type:* Prospect\n*Contact:* <${urls.contactUrl}|${contact.Name}>\n*Opportunity:* <${opportunity.url}|${opportunity.name}>`;
                          // Tag Guilherme for review
                          replyText += `\n\n<@${CONFIG.customerTagUser}> - new prospect opportunity created for review.`;
                        if (opportunity.note) replyText += `\n\n${opportunity.note}`;
                        await postThreadReply(client, message, replyText);
              } else {
                        await postThreadReply(client, message, `Failed to create opportunity for ${account.Name}. Please create manually.`);
              }
      } else {
              try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'information_source' }); } catch (e) {}
              await postThreadReply(client, message, `*Existing Customer Account*\n\n*Account:* <${urls.accountUrl}|${account.Name}>\n*Account Type:* ${accountType}\n*Contact:* <${urls.contactUrl}|${contact.Name}>\n\nNo opportunity created - existing customer.\n\n<@${CONFIG.customerTagUser}> - please review.`);
      }
    } catch (error) {
          logger.error('Error processing license request:', error);
          try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'x' }); } catch (e) {}
    }
});

async function postThreadReply(client, message, text) {
    try {
          await client.chat.postMessage({ channel: message.channel, thread_ts: message.ts, text, unfurl_links: false });
    } catch (error) {
          console.error('Error posting thread reply:', error.message);
    }
}

(async () => {
    await initSalesforce();
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log('Gong License Bot is running!');
    console.log(`Monitoring channel: ${CONFIG.licenseRequestChannel}`);
})();
