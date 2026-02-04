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
let sfTokenExpiry = null;

/**
 * Ensure Salesforce connection is valid, refresh if expired
 */
async function ensureSalesforceConnection() {
  // If no connection or token might be expired, reinitialize
  if (!sfConnection || (sfTokenExpiry && Date.now() > sfTokenExpiry)) {
    console.log('🔄 Salesforce session expired or missing, reconnecting...');
    return await initSalesforce();
  }
  return true;
}

/**
 * Execute a Salesforce query with automatic retry on session expiry
 */
async function sfQuery(soql, retried = false) {
  try {
    await ensureSalesforceConnection();
    return await sfConnection.query(soql);
  } catch (error) {
    // Check if this is a session expiry error
    if (!retried && (
      error.message.includes('Session expired') ||
      error.message.includes('INVALID_SESSION_ID') ||
      error.message.includes('invalid')
    )) {
      console.log('🔄 Session error detected, refreshing connection...');
      sfConnection = null; // Force reconnection
      const reconnected = await initSalesforce();
      if (reconnected) {
        return await sfQuery(soql, true); // Retry once
      }
    }
    throw error;
  }
}

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

    // Set token expiry (Salesforce tokens last ~2 hours, refresh after 1.5 hours to be safe)
    sfTokenExpiry = Date.now() + (90 * 60 * 1000); // 90 minutes

    console.log('✅ Connected to Salesforce (Client Credentials Flow)');
    console.log(`   Instance URL: ${tokenData.instance_url}`);
    console.log(`   Token expires at: ${new Date(sfTokenExpiry).toISOString()}`);

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
    const result = await sfQuery(
      `SELECT Id, Name FROM Account WHERE Name = '${CONFIG.gongResellerAccountName}' LIMIT 1`
    );

    if (result.records.length > 0) {
      CONFIG.gongResellerAccountId = result.records[0].Id;
      console.log(`✅ Cached Gong Reseller Account ID: ${CONFIG.gongResellerAccountId}`);
    } else {
      console.warn(`â ï¸ Could not find account named "${CONFIG.gongResellerAccountName}"`);
    }
  } catch (error) {
    console.error('❌ Error caching Gong Reseller Account ID:', error.message);
  }
}

/**
 * Extract customer admin email from Zapier license request message
 */
function extractCustomerAdminEmail(text) {
  // Clean up Slack formatting first
  const cleanText = text
    .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')  // <mailto:email|display> -> email
    .replace(/<mailto:([^>]+)>/g, '$1')          // <mailto:email> -> email
    .replace(/\*/g, '');                          // Remove bold markers

  // Look for "Customer Admin:" followed by name and email
  const emailPattern = /Customer Admin:.*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
  const match = cleanText.match(emailPattern);

  if (match) {
    const email = match[1].toLowerCase().trim();
    console.log(`📧 Extracted email: ${email}`);
    return email;
  }

  // Fallback: try to find any email after "Customer Admin"
  const lines = cleanText.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('customer admin')) {
      const emailMatch = line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch) {
        const email = emailMatch[1].toLowerCase().trim();
        console.log(`📧 Extracted email (fallback): ${email}`);
        return email;
      }
    }
  }

  return null;
}

/**
 * Extract customer name (company name) from Zapier license request message
 */
function extractCustomerName(text) {
  // Clean up Slack formatting first
  const cleanText = text
    .replace(/\*/g, '')                           // Remove asterisks (bold)
    .replace(/<[^>]+>/g, '');                     // Remove Slack link formatting

  const pattern = /Customer Name:\s*(.+)/i;
  const match = cleanText.match(pattern);

  if (match) {
    // Also trim any trailing formatting or newline content
    let name = match[1].trim();
    // Stop at newline if present
    const newlinePos = name.indexOf('\n');
    if (newlinePos > 0) {
      name = name.substring(0, newlinePos).trim();
    }
    console.log(`🏢 Extracted customer name: ${name}`);
    return name;
  }
  return null;
}

/**
 * Extract Customer Admin's full name from Zapier license request message
 * Returns { firstName, lastName }
 */
function extractCustomerAdminName(text) {
  console.log('📝 Attempting to extract admin name from text...');

  // Clean up Slack formatting - remove link formatting and bold/italic markers
  let cleanText = text
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')  // <mailto:email|display> -> display
    .replace(/<mailto:[^>]+>/g, '')              // <mailto:email> -> empty
    .replace(/<[^>]+>/g, '')                     // Remove any other Slack link formatting
    .replace(/\*/g, '');                         // Remove asterisks (Slack bold formatting)

  // Look for "Customer Admin:" followed by the name before the email
  // Handle names with hyphens, apostrophes, and accented characters
  const pattern = /Customer Admin:\s*([A-Za-zÀ-ÖØ-öø-ÿ'-]+)\s+([A-Za-zÀ-ÖØ-öø-ÿ'-]+)\s+[a-zA-Z0-9._%+-]+@/i;
  const match = cleanText.match(pattern);

  if (match) {
    console.log(`✅ Extracted name (primary): ${match[1]} ${match[2]}`);
    return {
      firstName: match[1],
      lastName: match[2]
    };
  }

  // Fallback: try to extract any name before the email on the Customer Admin line
  // Normalize line breaks (handle \r\n, \r, \n)
  const lines = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('customer admin')) {
      console.log(`📝 Found Customer Admin line: ${line.substring(0, 100)}...`);

      // Try to find name pattern - capture two words after "Customer Admin:"
      // More flexible pattern that captures names before any email-like pattern
      const nameMatch = line.match(/Customer Admin:\s*([A-Za-zÀ-ÖØ-öø-ÿ'-]+)\s+([A-Za-zÀ-ÖØ-öø-ÿ'-]+)/i);
      if (nameMatch) {
        console.log(`✅ Extracted name (fallback): ${nameMatch[1]} ${nameMatch[2]}`);
        return {
          firstName: nameMatch[1],
          lastName: nameMatch[2]
        };
      }
    }
  }

  console.log('❌ Could not extract admin name from message');
  return null;
}

/**
 * Search for a Contact in Salesforce by email
 */
async function findContactByEmail(email) {
  try {
    // Clean the email - remove any hidden characters or whitespace
    const cleanEmail = email.trim().toLowerCase();
    console.log(`🔍 Searching for contact by email: ${cleanEmail}`);

    const result = await sfQuery(
      `SELECT Id, Name, Email, AccountId, Account.Id, Account.Name, Account.Type
       FROM Contact
       WHERE Email = '${cleanEmail}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      console.log(`✅ Found contact: ${result.records[0].Name}`);
      return result.records[0];
    }

    console.log(`⚠️ No contact found with email: ${cleanEmail}`);
    return null;
  } catch (error) {
    console.error('❌ Error searching for contact:', error.message);
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
    let result = await sfQuery(
      `SELECT Id, Name, Email, AccountId, Account.Id, Account.Name, Account.Type
       FROM Contact
       WHERE Email = '${email}' AND AccountId = '${accountId}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }

    // Try case-insensitive email search on account
    result = await sfQuery(
      `SELECT Id, Name, Email, AccountId, Account.Id, Account.Name, Account.Type
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
    console.error('❌ Error searching for contact by email and account:', error.message);
    return null;
  }
}

/**
 * Get Account details by ID
 */
async function getAccountById(accountId) {
  try {
    const result = await sfQuery(
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

    console.log(`ð Searching for account by domain: ${domain}`);

    // Search by Website field containing the domain
    let result = await sfQuery(
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
      result = await sfQuery(
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
 * Check if account has an active Gong subscription
 * Looks for Ruby__Subscription__c where:
 * - Customer_Account_Id__c = accountId
 * - Ruby__Status__c = 'Active'
 * - Ruby__BillingAccount__c = Gong Reseller Account ID
 */
async function findActiveGongSubscription(accountId) {
  try {
    if (!CONFIG.gongResellerAccountId) {
      console.log('⚠️ Gong Reseller Account ID not cached, cannot check subscriptions');
      return null;
    }

    console.log(`🔍 Checking for active Gong subscription for account: ${accountId}`);

    const result = await sfQuery(
      `SELECT Id, Name, Ruby__Status__c, Ruby__BillingAccount__c, Ruby__Quantity__c,
              Ruby__ProductName__c, Ruby__SubscriptionStartDate__c, Ruby__SubscriptionEndDate__c
       FROM Ruby__Subscription__c
       WHERE Customer_Account_Id__c = '${accountId}'
       AND Ruby__Status__c = 'Active'
       AND Ruby__BillingAccount__c = '${CONFIG.gongResellerAccountId}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      console.log(`✅ Found active Gong subscription: ${result.records[0].Name}`);
      return result.records[0];
    }

    console.log('ℹ️ No active Gong subscription found');
    return null;
  } catch (error) {
    // Ruby__Subscription__c object might not exist or field names might be different
    console.error('❌ Error checking for Gong subscription:', error.message);
    return null;
  }
}

/**
 * Search for an Account by name (fallback)
 */
async function findAccountByName(accountName) {
  try {
    // Try exact match first
    let result = await sfQuery(
      `SELECT Id, Name, Type
       FROM Account
       WHERE Name = '${accountName.replace(/'/g, "\\'")}'
       LIMIT 1`
    );

    if (result.records.length > 0) {
      return result.records[0];
    }

    // Try LIKE match (contains)
    result = await sfQuery(
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
      const contact = await sfQuery(
        `SELECT Id, Name, Email, AccountId, Account.Id, Account.Name, Account.Type
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
      // Hardcoded fields for all Gong License Bot requests
      Won_Lost_Reason__c: 'Gong Reseller Referral',
      Main_Competitor__c: 'No Competitor',
      MSA_Redlines__c: 'No',
    };

    // Add BillingAccount if we have the Gong Reseller Account ID cached
    if (CONFIG.gongResellerAccountId) {
      opportunityData.BillingAccount__c = CONFIG.gongResellerAccountId;
    }

    // Add Contact fields if we have the contact ID
    if (contact && contact.Id) {
      opportunityData.OnBoarding_Contact__c = contact.Id;
      opportunityData.Primary_Contact__c = contact.Id;
    }

    const result = await sfConnection.sobject('Opportunity').create(opportunityData);

    if (result.success) {
      console.log(`✅ Created Opportunity: ${oppName} (${result.id})`);
      console.log(`   AccountId: ${account.Id}`);
      console.log(`   BillingAccount__c: ${CONFIG.gongResellerAccountId || 'not set'}`);
      console.log(`   OnBoarding_Contact__c: ${contact?.Id || 'not set'}`);
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
      console.log(`✅ Created Opportunity (without custom fields): ${oppName} (${result.id})`);
      return {
        id: result.id,
        name: oppName,
        url: `${CONFIG.sfInstanceUrl}/lightning/r/Opportunity/${result.id}/view`,
        note: 'â ï¸ Note: BillingAccount__c and OnBoarding_Contact__c were not set - please add manually',
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
          '❌ Could not connect to Salesforce. Please process manually.');
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
        logger.info(`✅ Found account: ${account.Name} (${account.Id})`);

        // Try to find existing contact on this account (might exist with slightly different email search)
        const existingContact = await findContactByEmailAndAccount(customerEmail, account.Id);
        if (existingContact) {
          logger.info(`✅ Found existing contact on account: ${existingContact.Name}`);
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
              logger.info(`✅ Contact created successfully`);
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

    logger.info(`✅ Found Contact: ${contact.Name} (Account: ${contact.Account?.Name})`);

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
      // Customer account - don't create opportunity, check for existing Gong subscription
      logger.info('ℹ️ Customer account - checking for existing Gong subscription');

      // Check if they have an active Gong subscription
      const gongSubscription = await findActiveGongSubscription(account.Id);

      // Add info reaction
      try {
        await client.reactions.add({
          channel: message.channel,
          timestamp: message.ts,
          name: 'information_source',
        });
      } catch (e) {}

      let replyText = `ℹ️ *Existing Customer Account*\n\n` +
        `*Account:* <${urls.accountUrl}|${account.Name}>\n` +
        `*Account Type:* ${accountType}\n` +
        `*Contact:* <${urls.contactUrl}|${contact.Name}>${contactCreated ? ' _(newly created)_' : ''}\n\n`;

      if (gongSubscription) {
        // Has existing Gong subscription - provide CLM instructions
        replyText += `✅ *Has Active Gong Subscription:* ${gongSubscription.Name || 'Yes'}\n`;
        if (gongSubscription.Ruby__Quantity__c) {
          replyText += `*Current Quantity:* ${gongSubscription.Ruby__Quantity__c}\n`;
        }
        replyText += `\n📋 *To add licenses:*\n`;
        replyText += `1. Go to Customer Lifecycle Manager\n`;
        replyText += `2. Update quantity on the subscription\n`;
        replyText += `3. Checkout → Activate the order → Activate the order → Carry on\n`;
      } else {
        // No Gong subscription - they need to set one up
        replyText += `⚠️ *No active Gong reseller subscription found*\n\n`;
        replyText += `This customer may need a new Gong subscription set up.`;
      }

      replyText += `\n\n<@${CONFIG.customerTagUser}> - please review this license request.`;

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
        text: '❌ Could not find the parent message.',
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
          logger.info(`✅ Found existing contact on account: ${existingContact.Name}`);
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
              logger.info(`✅ Contact created: ${contact.Name}`);
            }
          }
        }
      }

      if (!contact) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: `❌ Contact not found for: ${customerEmail}\nCustomer Name: ${customerName || 'Unknown'}\nCould not auto-create contact. Please create manually.`,
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
  console.log('â¡ï¸ Gong License Bot is running!');
  console.log(`ð¡ Monitoring channel: ${CONFIG.licenseRequestChannel}`);
  console.log(`ð¤ Customer tag user: ${CONFIG.customerTagUser}`);
  console.log(`ð Salesforce instance: ${CONFIG.sfInstanceUrl}`);
  console.log('');
})();
