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

    console.log('â Connected to Salesforce (Client Credentials Flow)');
    console.log(`   Instance URL: ${tokenData.instance_url}`);

    // Cache the Gong Reseller Account ID if not already set
    if (!CONFIG.gongResellerAccountId) {
      await cacheGongResellerAccountId();
    }

    return true;
  } catch (error) {
    console.error('â Salesforce connection failed:', error.message);
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
      console.log(`â Cached Gong Reseller Account ID: ${CONFIG.gongResellerAccountId}`);
    } else {
      console.warn(`â ï¸ Could not find account named "${CONFIG.gongResellerAccountName}"`);
    }
  } catch (error) {
    console.error('â Error caching Gong Reseller Account ID:', error.message);
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
  const pattern = /Customer Admin:\s*([A-Za-z]+)\s+([A-Za-z]+)\s*(?:<mailto:|[a-zA-Z0-9._%+-]+@)/i;
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
    console.error('â Error searching for contact:', error.message);
    return null;
  }
}

/**
 * Find contact by email AND account ID (more thorough search)
 * This helps find contacts that might exist on the account even if email search didn't work
 */
async function findContactByEmailAndAccount(email, accountId) {
  try {
    // First try exact email match on account
    let result = await sfConnection.query(
      `SELECT Id, Name, Email, AccountId, Account.Name, Account.Type
       FROM Contact
       WHERE Email = '${email}' AND AccountId = '${accountId}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }

    // Try case-insensitive email search on account
    result = await sfConnection.query(
      `SELECT Id, Name, Email, AccountId, Account.Name, Account.Type
       FROM Contact
       WHERE AccountId = '${accountId}'
       LIMIT 10`
    );

    // Check for email match (case-insensitive)
    const emailLower = email.toLowerCase();
    for (const contact of result.records) {
      if (contact.Email && contact.Email.toLowerCase() === emailLower) {
        return contact;
      }
    }

    return null;
  } catch (error) {
    console.error('â Error searching for contact by email and account:', error.message);
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
    console.error('â Error fetching account:', error.message);
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

    console.log(`ð Searching for account by domain: ${domain}`);

    // Search by Website field containing the domain
    let result = await sfConnection.query(
      `SELECT Id, Name, Type, Website
       FROM Account
       WHERE Website LIKE '%${domain}%'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      console.log(`â Found account by website: ${result.records[0].Name}`);
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
        console.log(`â Found account by Domain__c: ${result.records[0].Name}`);
        return result.records[0];
      }
    } catch (e) {
      // Domain__c field might not exist, ignore
    }

    return null;
  } catch (error) {
    console.error('â Error searching for account by domain:', error.message);
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
    console.error('â Error searching for account by name:', error.message);
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
      console.log(`â Created Contact: ${firstName} ${lastName} (${result.id})`);

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
      console.error('â Failed to create contact:', result.errors);
      return null;
    }
  } catch (error) {
    console.error('â Error creating contact:', error.message);
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
      // Hardcoded fields for all Gong License Bot requests
      BillingAccount__c: '001PK00000XxXxxYAF',
      Won_Lost_Reason__c: 'Gong Reseller Referral',
      Main_Competitor__c: 'No Competitor',
      MSA_Redlines__c: 'No',
    };

    // Add Contact fields if we have the contact ID
    if (contact && contact.Id) {
      opportunityData.OnBoarding_Contact__c = contact.Id;
      opportunityData.Primary_Contact__c = contact.Id;
    }

    const result = await sfConnection.sobject('Opportunity').create(opportunityData);

    if (result.success) {
      console.log(`â Created Opportunity: ${oppName} (${result.id})`);
      console.log(`   AccountId: ${account.Id}`);
      console.log(`   BillingAccount__c: 001PK00000XxXxxYAF`);
      console.log(`   OnBoarding_Contact__c: ${contact?.Id || 'not set'}`);
      return {
        id: result.id,
        name: oppName,
        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
      };
    } else {
      console.error('â Failed to create opportunity:', result.errors);
      return null;
    }
  } catch (error) {
    console.error('â Error creating opportunity:', error.message);

    // If a custom field doesn't exist, try without it
    if (error.message.includes('BillingAccount__c') || error.message.includes('OnBoarding_Contact__c') || error.message.includes('No such column')) {
      console.log('â ï¸ Custom field not found, retrying with basic fields...');
      return await createOpportunityWithoutCustomFields(contact, account);
    }

    return null;
  }
}

/**
 * Create opportunity without custom fields (fallback)
 */
async function createOpportunityWithoutCustomFields(contact, account) {
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
      console.log(`â Created Opportunity (without custom fields): ${oppName} (${result.id})`);
      return {
        id: result.id,
        name: oppName,
        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
        note: 'â ï¸ Note: BillingAccount__c and OnBoarding_Contact__c were not set - please add manually',
      };
    }
    return null;
  } catch (error) {
    console.error('â Error creating opportunity (fallback):', error.message);
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

    logger.info('ð New ChiliPiper License Request detected!');

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
      logger.warn('â ï¸ Could not extract customer admin email from message');
      await postThreadReply(client, message,
        'â ï¸ Could not extract customer admin email from this request. Please process manually.');
      return;
    }

    logger.info(`ð§ Customer Admin Email: ${customerEmail}`);
    logger.info(`ð¢ Customer Name: ${customerName}`);

    // Ensure Salesforce connection
    if (!sfConnection) {
      const connected = await initSalesforce();
      if (!connected) {
        await postThreadReply(client, message,
          'â Could not connect to Salesforce. Please process manually.');
        return;
      }
    }

    // Search for contact in Salesforce
    let contact = await findContactByEmail(customerEmail);
    let contactCreated = false;

    if (!contact) {
      logger.warn(`â ï¸ Contact not found in Salesforce: ${customerEmail}`);

      // Try to find the account by domain first (e.g., amtechsoftware.com from jtipton@amtechsoftware.com)
      logger.info(`ð Searching for account by email domain...`);
      let account = await findAccountByDomain(customerEmail);

      // Fallback to company name search if domain search fails
      if (!account && customerName) {
        logger.info(`ð Domain search failed, trying company name: ${customerName}`);
        account = await findAccountByName(customerName);
      }

      if (account) {
        logger.info(`â Found account: ${account.Name} (${account.Id})`);

        // Try to find existing contact on this account (might exist with slightly different email search)
        const existingContact = await findContactByEmailAndAccount(customerEmail, account.Id);
        if (existingContact) {
          logger.info(`â Found existing contact on account: ${existingContact.Name}`);
          contact = existingContact;
        } else {
          // Extract customer admin name
          const adminName = extractCustomerAdminName(text);

          if (adminName) {
            logger.info(`ð¤ Creating contact: ${adminName.firstName} ${adminName.lastName}`);

            contact = await createContact(
              adminName.firstName,
              adminName.lastName,
              customerEmail,
              account.Id
            );

            if (contact) {
              contactCreated = true;
              logger.info(`â Contact created successfully`);
            }
          } else {
            logger.warn('â ï¸ Could not extract customer admin name from message');
            await postThreadReply(client, message,
              `â ï¸ Contact not found for: \`${customerEmail}\`\n` +
              `Found account: *${account.Name}*\n` +
              `Could not extract admin name to create contact.\n\n` +
              `Please create the contact manually.`);
            return;
          }
        }
      } else {
        const emailDomain = customerEmail.split('@')[1];
        logger.warn(`â ï¸ Account not found by domain (${emailDomain}) or name (${customerName})`);
        await postThreadReply(client, message,
          `â ï¸ Contact not found in Salesforce for email: \`${customerEmail}\`\n` +
          `Account not found by domain: *${emailDomain}*\n` +
          `Account not found by name: *${customerName || 'Unknown'}*\n\n` +
          `Please create the account, contact, and opportunity manually.`);
        return;
      }

      if (!contact) {
        await postThreadReply(client, message,
          `â ï¸ Contact not found and could not be created for: \`${customerEmail}\`\n` +
          `Customer Name: ${customerName || 'Unknown'}\n\n` +
          `Please create the contact and opportunity manually.`);
        return;
      }
    }

    logger.info(`â Found Contact: ${contact.Name} (Account: ${contact.Account?.Name})`);

    // Get account details
    const account = contact.Account || await getAccountById(contact.AccountId);

    if (!account) {
      await postThreadReply(client, message,
        `â ï¸ Could not find account for contact: ${contact.Name}\n` +
        `Please process manually.`);
      return;
    }

    const accountType = account.Type || 'Unknown';
    const urls = buildSalesforceUrls(contact, account);

    logger.info(`ð Account Type: ${accountType}`);

    // Handle based on account type
    if (accountType.toLowerCase() === 'prospect') {
      // Create opportunity for Prospect
      logger.info('ð Creating opportunity for Prospect account...');

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

        let replyText = `â *Opportunity Created!*\n\n` +
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
          `â Failed to create opportunity for ${account.Name}.\n` +
          `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
          `*Contact:* <${urls.contactUrl}|${contact.Name}>\n\n` +
          `Please create the opportunity manually.`);
      }

    } else {
      // Customer account - don't create opportunity, just notify
      logger.info('â¹ï¸ Customer account - notifying team');

      // Add info reaction
      try {
        await client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'information_source',
        });
      } catch (e) {}

      const replyText = `â¹ï¸ *Existing Customer Account*\n\n` +
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
        text: 'ð To process a license request, mention me in the thread of a Zapier message.',
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
        text: 'â Could not find the parent message.',
      });
      return;
    }

    const parentMessage = result.messages[0];

    // Process the parent message as if it were a new license request
    logger.info('ð Manual processing triggered via @mention');

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
        text: 'â Could not find a customer email in this message.',
      });
      return;
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `ð Processing license request for: ${customerEmail}`,
    });

    // Check Salesforce connection
    if (!sfConnection) {
      const connected = await initSalesforce();
      if (!connected) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: 'â Could not connect to Salesforce. Please try again later.',
        });
        return;
      }
    }

    // Find the contact
    let contact = await findContactByEmail(customerEmail);
    let contactCreated = false;
    const customerName = extractCustomerName(parentMessage.text);

    if (!contact) {
      // Try to find account and create contact
      logger.info(`â ï¸ Contact not found, searching for account by domain...`);

      let account = await findAccountByDomain(customerEmail);
      if (!account && customerName) {
        account = await findAccountByName(customerName);
      }

      if (account) {
        // First try to find existing contact on this account
        const existingContact = await findContactByEmailAndAccount(customerEmail, account.Id);
        if (existingContact) {
          logger.info(`â Found existing contact on account: ${existingContact.Name}`);
          contact = existingContact;
        } else {
          // Try to create new contact
          const adminName = extractCustomerAdminName(parentMessage.text);
          if (adminName) {
            contact = await createContact(
              adminName.firstName,
              adminName.lastName,
              customerEmail,
              account.Id
            );
            if (contact) {
              contactCreated = true;
              logger.info(`â Contact created: ${contact.Name}`);
            }
          }
        }
      }

      if (!contact) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: `â Contact not found for: ${customerEmail}\nCustomer Name: ${customerName || 'Unknown'}\nCould not auto-create contact. Please create manually.`,
        });
        return;
      }
    }

    // Get account
    const account = contact.Account || await getAccountById(contact.AccountId);
    if (!account) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `â Could not find account for contact: ${contact.Name}`,
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

        let replyText = `â *Opportunity Created!*\n\n` +
          `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
          `*Account Type:* Prospect\n` +
          `*Contact:* <${urls.contactUrl}|${contact.Name}>${contactCreated ? ' _(newly created)_' : ''}\n` +
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
          text: `â Failed to create opportunity for ${account.Name}.\n` +
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

      const replyText = `â¹ï¸ *Existing Customer Account*\n\n` +
        `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
        `*Account Type:* ${accountType}\n` +
        `*Contact:* <${urls.contactUrl}|${contact.Name}>${contactCreated ? ' _(newly created)_' : ''}\n\n` +
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
        text: `â Error processing request: ${error.message}`,
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
    console.error('â Error posting thread reply:', error.message);
  }
}

// Start the app
(async () => {
  // Initialize Salesforce connection
  await initSalesforce();

  const port = process.env.PORT || 3000;
  await app.start(port);

  console.log('');
  console.log('â¡ï¸ Gong License Bot is running!');
  console.log(`ð¡ Monitoring channel: ${CONFIG.licenseRequestChannel}`);
  console.log(`ð¤ Customer tag user: ${CONFIG.customerTagUser}`);
  console.log(`ð Salesforce instance: ${CONFIG.sfInstanceUrl}`);
  console.log('');
})();
