const { App } = require('@slack/bolt');
const jsforce = require('jsforce');
require('dotenv').config();

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Configuration
const CONFIG = {
  // Channel to monitor for license requests
  licenseRequestChannel: process.env.LICENSE_REQUEST_CHANNEL || 'C06JLLX47UK',

  // User to tag when account is a Customer
  customerTagUser: process.env.CUSTOMER_TAG_USER || 'U04SEQE79FE',

  // Salesforce instance URL for building links
  sfInstanceUrl: process.env.SF_INSTANCE_URL || 'https://chilipiper.lightning.force.com',

  // Gong Reseller Account name for Billing Account
  gongResellerAccountName: 'Gong - Reseller Account',

  // Cached Gong Reseller Account ID
  gongResellerAccountId: process.env.GONG_RESELLER_ACCOUNT_ID || null,
};

// Salesforce connection
let sfConnection = null;

/**
 * Initialize Salesforce connection using Client Credentials Flow (OAuth2)
 */
async function initSalesforce() {
  try {
    const clientId = process.env.SF_CLIENT_ID;
    const clientSecret = process.env.SF_CLIENT_SECRET;
    const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

    // Use Client Credentials Flow (OAuth2)
    const tokenResponse = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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

    // Create connection with the access token
    sfConnection = new jsforce.Connection({
      instanceUrl: tokenData.instance_url,
      accessToken: tokenData.access_token,
    });

    console.log('✅ Connected to Salesforce (Client Credentials Flow)');
    console.log(`   Instance URL: ${tokenData.instance_url}`);

    // Cache the Gong Reseller Account ID if not already set
    if (!CONFIG.gongResellerAccountId) {
      await cacheGongResellerAccountId();
    }

    return true;
  } catch (error) {
    console.error('❌ Salesforce connection failed:', error.message);
    return false;
  }
}

/**
 * Cache the Gong Reseller Account ID for faster opportunity creation
 */
async function cacheGongResellerAccountId() {
  try {
    const result = await sfConnection.query(
      `SELECT Id, Name FROM Account WHERE Name = '${CONFIG.gongResellerAccountName}' LIMIT 1`
    );

    if (result.records.length > 0) {
      CONFIG.gongResellerAccountId = result.records[0].Id;
      console.log(`✅ Cached Gong Reseller Account ID: ${CONFIG.gongResellerAccountId}`);
    } else {
      console.warn(`⚠️ Could not find account named "${CONFIG.gongResellerAccountName}"`);
    }
  } catch (error) {
    console.error('❌ Error caching Gong Reseller Account ID:', error.message);
  }
}

/**
 * Extract customer admin email from Zapier license request message
 */
function extractCustomerAdminEmail(text) {
  // Look for "Customer Admin:" followed by name and email
  const emailPattern = /Customer Admin:.*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
  const match = text.match(emailPattern);

  if (match) {
    return match[1].toLowerCase();
  }

  // Fallback: try to find any email after "Customer Admin"
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('customer admin')) {
      const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch) {
        return emailMatch[1].toLowerCase();
      }
    }
  }

  return null;
}

/**
 * Extract customer name (company name) from Zapier license request message
 */
function extractCustomerName(text) {
  const pattern = /Customer Name:\s*(.+)/i;
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Extract Customer Admin's full name from Zapier license request message
 * Returns { firstName, lastName }
 */
function extractCustomerAdminName(text) {
  // Look for "Customer Admin:" followed by the name before the email
  // Pattern: "Customer Admin: FirstName LastName email@example.com"
  const pattern = /Customer Admin:\s*([A-Za-z]+)\s+([A-Za-z]+)\s+[a-zA-Z0-9._%+-]+@/i;
  const match = text.match(pattern);

  if (match) {
    return {
      firstName: match[1],
      lastName: match[2]
    };
  }

  // Fallback: try to extract any name before the email on the Customer Admin line
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('customer admin')) {
      // Try to find name pattern before email
      const nameMatch = line.match(/Customer Admin:\s*([A-Za-z]+)\s+([A-Za-z]+)/i);
      if (nameMatch) {
        return {
          firstName: nameMatch[1],
          lastName: nameMatch[2]
        };
      }
    }
  }

  return null;
}

/**
 * Search for a Contact in Salesforce by email
 */
async function findContactByEmail(email) {
  try {
    const result = await sfConnection.query(
      `SELECT Id, Name, Email, AccountId, Account.Name, Account.Type
       FROM Contact
       WHERE Email = '${email}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }
    return null;
  } catch (error) {
    console.error('❌ Error searching for contact:', error.message);
    return null;
  }
}

/**
 * Get Account details by ID
 */
async function getAccountById(accountId) {
  try {
    const result = await sfConnection.query(
      `SELECT Id, Name, Type
       FROM Account
       WHERE Id = '${accountId}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }
    return null;
  } catch (error) {
    console.error('❌ Error fetching account:', error.message);
    return null;
  }
}

/**
 * Search for an Account by domain (from email)
 */
async function findAccountByDomain(email) {
  try {
    // Extract domain from email
    const domain = email.split('@')[1];
    if (!domain) {
      return null;
    }

    console.log(`🔍 Searching for account by domain: ${domain}`);

    // Search by Website field containing the domain
    let result = await sfConnection.query(
      `SELECT Id, Name, Type, Website
       FROM Account
       WHERE Website LIKE '%${domain}%'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      console.log(`✅ Found account by website: ${result.records[0].Name}`);
      return result.records[0];
    }

    // Also try searching by domain field if it exists, or by the Domain custom field
    // Common field names: Domain__c, Email_Domain__c, Website_Domain__c
    try {
      result = await sfConnection.query(
        `SELECT Id, Name, Type, Website
         FROM Account
         WHERE Domain__c = '${domain}'
         LIMIT 1`
      );

      if (result.records.length > 0) {
        console.log(`✅ Found account by Domain__c: ${result.records[0].Name}`);
        return result.records[0];
      }
    } catch (e) {
      // Domain__c field might not exist, ignore
    }

    return null;
  } catch (error) {
    console.error('❌ Error searching for account by domain:', error.message);
    return null;
  }
}

/**
 * Search for an Account by name (fallback)
 */
async function findAccountByName(accountName) {
  try {
    // Try exact match first
    let result = await sfConnection.query(
      `SELECT Id, Name, Type
       FROM Account
       WHERE Name = '${accountName.replace(/'/g, "\\'")}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }

    // Try LIKE match (contains)
    result = await sfConnection.query(
      `SELECT Id, Name, Type
       FROM Account
       WHERE Name LIKE '%${accountName.replace(/'/g, "\\'")}%'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }

    return null;
  } catch (error) {
    console.error('❌ Error searching for account by name:', error.message);
    return null;
  }
}

/**
 * Create a new Contact in Salesforce
 */
async function createContact(firstName, lastName, email, accountId) {
  try {
    const contactData = {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      AccountId: accountId,
    };

    const result = await sfConnection.sobject('Contact').create(contactData);

    if (result.success) {
      console.log(`✅ Created Contact: ${firstName} ${lastName} (${result.id})`);

      // Fetch the full contact record to return
      const contact = await sfConnection.query(
        `SELECT Id, Name, Email, AccountId, Account.Name, Account.Type
         FROM Contact
         WHERE Id = '${result.id}'
         LIMIT 1`
      );

      if (contact.records.length > 0) {
        return contact.records[0];
      }

      // Return basic info if query fails
      return {
        Id: result.id,
        Name: `${firstName} ${lastName}`,
        Email: email,
        AccountId: accountId,
      };
    } else {
      console.error('❌ Failed to create contact:', result.errors);
      return null;
    }
  } catch (error) {
    console.error('❌ Error creating contact:', error.message);
    return null;
  }
}

/**
 * Create a new Opportunity for a Prospect account
 */
async function createOpportunity(contact, account, customerName) {
  try {
    // Calculate close date (30 days from now)
    const closeDate = new Date();
    closeDate.setDate(closeDate.getDate() + 30);
    const closeDateStr = closeDate.toISOString().split('T')[0];

    // Build opportunity name: "Account Name - Inbound"
    const oppName = `${account.Name} - Inbound`;

    const opportunityData = {
      Name: oppName,
      AccountId: account.Id,
      StageName: 'Demo', // From your screenshot
      CloseDate: closeDateStr,
      Type: 'Inbound',
      LeadSource: 'Partner', // Since it's from Gong
    };

    // Add Billing Account if we have the Gong Reseller Account ID
    if (CONFIG.gongResellerAccountId) {
      opportunityData.Billing_Account__c = CONFIG.gongResellerAccountId;
    }

    const result = await sfConnection.sobject('Opportunity').create(opportunityData);

    if (result.success) {
      console.log(`✅ Created Opportunity: ${oppName} (${result.id})`);
      return {
        id: result.id,
        name: oppName,
        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
      };
    } else {
      console.error('❌ Failed to create opportunity:', result.errors);
      return null;
    }
  } catch (error) {
    console.error('❌ Error creating opportunity:', error.message);

    // If the Billing_Account__c field doesn't exist, try without it
    if (error.message.includes('Billing_Account__c') || error.message.includes('No such column')) {
      console.log('⚠️ Billing_Account__c field not found, retrying without it...');
      return await createOpportunityWithoutBilling(contact, account);
    }

    return null;
  }
}

/**
 * Create opportunity without Billing Account field (fallback)
 */
async function createOpportunityWithoutBilling(contact, account) {
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

    const result = await sfConnection.sobject('Opportunity').create(opportunityData);

    if (result.success) {
      console.log(`✅ Created Opportunity (without Billing Account): ${oppName} (${result.id})`);
      return {
        id: result.id,
        name: oppName,
        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
        note: '⚠️ Note: Billing Account was not set - please add manually',
      };
    }
    return null;
  } catch (error) {
    console.error('❌ Error creating opportunity (fallback):', error.message);
    return null;
  }
}

/**
 * Build Salesforce URLs
 */
function buildSalesforceUrls(contact, account) {
  return {
    contactUrl: `${CONFIG.sfInstanceUrl}/lightning/r/Contact/${contact.Id}/view`,
    accountUrl: `${CONFIG.sfInstanceUrl}/lightning/r/Account/${account.Id}/view`,
  };
}

/**
 * Main message handler for license requests
 */
app.message(async ({ message, client, logger }) => {
  try {
    // Skip bot messages (except from Zapier) and message edits
    if (message.subtype === 'message_changed') {
      return;
    }

    // Only monitor the specific channel
    if (message.channel !== CONFIG.licenseRequestChannel) {
      return;
    }

    const text = message.text || '';

    // Check if this is a license request message
    if (!text.includes('New ChiliPiper License Request Submitted!')) {
      return;
    }

    logger.info('🔔 New ChiliPiper License Request detected!');

    // Add eyes emoji to show we're processing
    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'eyes',
      });
    } catch (e) {
      // Reaction might already exist
    }

    // Extract customer admin email
    const customerEmail = extractCustomerAdminEmail(text);
    const customerName = extractCustomerName(text);

    if (!customerEmail) {
      logger.warn('⚠️ Could not extract customer admin email from message');
      await postThreadReply(client, message,
        '⚠️ Could not extract customer admin email from this request. Please process manually.');
      return;
    }

    logger.info(`📧 Customer Admin Email: ${customerEmail}`);
    logger.info(`🏢 Customer Name: ${customerName}`);

    // Ensure Salesforce connection
    if (!sfConnection) {
      const connected = await initSalesforce();
      if (!connected) {
        await postThreadReply(client, message,
          '❌ Could not connect to Salesforce. Please process manually.');
        return;
      }
    }

    // Search for contact in Salesforce
    let contact = await findContactByEmail(customerEmail);
    let contactCreated = false;

    if (!contact) {
      logger.warn(`⚠️ Contact not found in Salesforce: ${customerEmail}`);

      // Try to find the account by domain first (e.g., amtechsoftware.com from jtipton@amtechsoftware.com)
      logger.info(`🔍 Searching for account by email domain...`);
      let account = await findAccountByDomain(customerEmail);

      // Fallback to company name search if domain search fails
      if (!account && customerName) {
        logger.info(`🔍 Domain search failed, trying company name: ${customerName}`);
        account = await findAccountByName(customerName);
      }

      if (account) {
        logger.info(`✅ Found account: ${account.Name} (${account.Id})`);

        // Extract customer admin name
        const adminName = extractCustomerAdminName(text);

        if (adminName) {
          logger.info(`👤 Creating contact: ${adminName.firstName} ${adminName.lastName}`);

          contact = await createContact(
            adminName.firstName,
            adminName.lastName,
            customerEmail,
            account.Id
          );

          if (contact) {
            contactCreated = true;
            logger.info(`✅ Contact created successfully`);
          }
        } else {
          logger.warn('⚠️ Could not extract customer admin name from message');
          await postThreadReply(client, message,
            `⚠️ Contact not found for: \`${customerEmail}\`\n` +
            `Found account: *${account.Name}*\n` +
            `Could not extract admin name to create contact.\n\n` +
            `Please create the contact manually.`);
          return;
        }
      } else {
        const emailDomain = customerEmail.split('@')[1];
        logger.warn(`⚠️ Account not found by domain (${emailDomain}) or name (${customerName})`);
        await postThreadReply(client, message,
          `⚠️ Contact not found in Salesforce for email: \`${customerEmail}\`\n` +
          `Account not found by domain: *${emailDomain}*\n` +
          `Account not found by name: *${customerName || 'Unknown'}*\n\n` +
          `Please create the account, contact, and opportunity manually.`);
        return;
      }

      if (!contact) {
        await postThreadReply(client, message,
          `⚠️ Contact not found and could not be created for: \`${customerEmail}\`\n` +
          `Customer Name: ${customerName || 'Unknown'}\n\n` +
          `Please create the contact and opportunity manually.`);
        return;
      }
    }

    logger.info(`✅ Found Contact: ${contact.Name} (Account: ${contact.Account?.Name})`);

    // Get account details
    const account = contact.Account || await getAccountById(contact.AccountId);

    if (!account) {
      await postThreadReply(client, message,
        `⚠️ Could not find account for contact: ${contact.Name}\n` +
        `Please process manually.`);
      return;
    }

    const accountType = account.Type || 'Unknown';
    const urls = buildSalesforceUrls(contact, account);

    logger.info(`📊 Account Type: ${accountType}`);

    // Handle based on account type
    if (accountType.toLowerCase() === 'prospect') {
      // Create opportunity for Prospect
      logger.info('🚀 Creating opportunity for Prospect account...');

      const opportunity = await createOpportunity(contact, account, customerName);

      if (opportunity) {
        // Success - add checkmark reaction
        try {
          await client.reactions.add({
            channel: message.channel,
            timestamp: message.ts,
            name: 'white_check_mark',
          });
        } catch (e) {}

        let replyText = `✅ *Opportunity Created!*\n\n` +
          `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
          `*Account Type:* Prospect\n` +
          `*Contact:* <${urls.contactUrl}|${contact.Name}>${contactCreated ? ' _(newly created)_' : ''}\n` +
          `*Opportunity:* <${opportunity.url}|${opportunity.name}>`;

        if (opportunity.note) {
          replyText += `\n\n${opportunity.note}`;
        }

        // Tag Guilherme for review
        replyText += `\n\n<@${CONFIG.customerTagUser}> - new prospect opportunity created for review.`;

        await postThreadReply(client, message, replyText);
      } else {
        await postThreadReply(client, message,
          `❌ Failed to create opportunity for ${account.Name}.\n` +
          `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
          `*Contact:* <${urls.contactUrl}|${contact.Name}>\n\n` +
          `Please create the opportunity manually.`);
      }

    } else {
      // Customer account - don't create opportunity, just notify
      logger.info('ℹ️ Customer account - notifying team');

      // Add info reaction
      try {
        await client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'information_source',
        });
      } catch (e) {}

      const replyText = `ℹ️ *Existing Customer Account*\n\n` +
        `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
        `*Account Type:* ${accountType}\n` +
        `*Contact:* <${urls.contactUrl}|${contact.Name}>${contactCreated ? ' _(newly created)_' : ''}\n\n` +
        `No opportunity created - this is an existing customer.\n\n` +
        `<@${CONFIG.customerTagUser}> - please review this license request.`;

      await postThreadReply(client, message, replyText);
    }

  } catch (error) {
    logger.error('Error processing license request:', error);

    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'x',
      });
    } catch (e) {}
  }
});

/**
 * App mention handler - allows manual processing of messages
 * Usage: @Gong License Bot in a thread to reprocess that message
 */
app.event('app_mention', async ({ event, client, logger }) => {
  try {
    // Check if this mention is in a thread
    if (!event.thread_ts) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: '👋 To process a license request, mention me in the thread of a Zapier message.',
      });
      return;
    }

    // Get the parent message of this thread
    const result = await client.conversations.history({
      channel: event.channel,
      latest: event.thread_ts,
      inclusive: true,
      limit: 1,
    });

    if (!result.messages || result.messages.length === 0) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '❌ Could not find the parent message.',
      });
      return;
    }

    const parentMessage = result.messages[0];

    // Process the parent message as if it were a new license request
    logger.info('📋 Manual processing triggered via @mention');

    // Simulate the message object
    const simulatedMessage = {
      ...parentMessage,
      channel: event.channel,
    };

    // Extract email from the message
    const customerEmail = extractCustomerAdminEmail(parentMessage.text);
    if (!customerEmail) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: '❌ Could not find a customer email in this message.',
      });
      return;
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `🔄 Processing license request for: ${customerEmail}`,
    });

    // Check Salesforce connection
    if (!sfConnection) {
      const connected = await initSalesforce();
      if (!connected) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: '❌ Could not connect to Salesforce. Please try again later.',
        });
        return;
      }
    }

    // Find the contact
    const contact = await findContactByEmail(customerEmail);
    if (!contact) {
      const customerName = extractCustomerName(parentMessage.text);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `❌ Contact not found for: ${customerEmail}\nCustomer Name: ${customerName || 'Unknown'}\nPlease create manually.`,
      });
      return;
    }

    // Get account
    const account = contact.Account || await getAccountById(contact.AccountId);
    if (!account) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `❌ Could not find account for contact: ${contact.Name}`,
      });
      return;
    }

    const accountType = account.Type || 'Unknown';
    const urls = buildSalesforceUrls(contact, account);

    // Process based on account type
    if (accountType.toLowerCase() === 'prospect') {
      // Prospect - create opportunity
      const opportunity = await createOpportunity(contact, account);

      if (opportunity) {
        // Success reaction
        try {
          await client.reactions.add({
            channel: event.channel,
            timestamp: event.thread_ts,
            name: 'white_check_mark',
          });
        } catch (e) {}

        let replyText = `✅ *Opportunity Created!*\n\n` +
          `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
          `*Account Type:* Prospect\n` +
          `*Contact:* <${urls.contactUrl}|${contact.Name}>\n` +
          `*Opportunity:* <${opportunity.url}|${opportunity.name}>`;

        if (opportunity.note) {
          replyText += `\n\n${opportunity.note}`;
        }

        // Tag Guilherme for review
        replyText += `\n\n<@${CONFIG.customerTagUser}> - new prospect opportunity created for review.`;

        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: replyText,
        });
      } else {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: `❌ Failed to create opportunity for ${account.Name}.\n` +
            `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
            `*Contact:* <${urls.contactUrl}|${contact.Name}>\n\n` +
            `Please create the opportunity manually.`,
        });
      }
    } else {
      // Customer account
      try {
        await client.reactions.add({
          channel: event.channel,
          timestamp: event.thread_ts,
          name: 'information_source',
        });
      } catch (e) {}

      const replyText = `ℹ️ *Existing Customer Account*\n\n` +
        `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
        `*Account Type:* ${accountType}\n` +
        `*Contact:* <${urls.contactUrl}|${contact.Name}>\n\n` +
        `No opportunity created - this is an existing customer.\n\n` +
        `<@${CONFIG.customerTagUser}> - please review this license request.`;

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: replyText,
      });
    }

  } catch (error) {
    logger.error('Error processing app_mention:', error);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: `❌ Error processing request: ${error.message}`,
      });
    } catch (e) {}
  }
});

/**
 * Post a reply in the message thread
 */
async function postThreadReply(client, message, text) {
  try {
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: text,
      unfurl_links: false,
    });
  } catch (error) {
    console.error('❌ Error posting thread reply:', error.message);
  }
}

// Start the app
(async () => {
  // Initialize Salesforce connection
  await initSalesforce();

  const port = process.env.PORT || 3000;
  await app.start(port);

  console.log('');
  console.log('⚡️ Gong License Bot is running!');
  console.log(`📡 Monitoring channel: ${CONFIG.licenseRequestChannel}`);
  console.log(`👤 Customer tag user: ${CONFIG.customerTagUser}`);
  console.log(`🔗 Salesforce instance: ${CONFIG.sfInstanceUrl}`);
  console.log('');
})();
