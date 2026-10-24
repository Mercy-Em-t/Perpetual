/**
 * ============================================================================
 * Google Apps Script: Google Drive Reference Image Ingestion Pipeline
 * File: drive_apps_script.js
 * ============================================================================
 * 
 * Purpose:
 * Monitors a designated Google Drive folder for newly uploaded reference images,
 * converts them to base64-encoded blobs, and dispatches them via webhook POST
 * to the Shared Agent Room microservice (/api/drive/ingest).
 * 
 * Deployment Instructions:
 * 1. Open Google Apps Script: https://script.google.com
 * 2. Create a new project named "Shared Agent Room - Drive Ingestion"
 * 3. Replace Code.gs with the code below.
 * 4. Update CONFIG.FOLDER_ID with your target Google Drive Folder ID.
 * 5. Update CONFIG.ROOM_WEBHOOK_URL with your Shared Agent Room ingest endpoint
 *    (e.g., https://<your-cloudflare-tunnel-or-domain>/api/drive/ingest,
 *    or ngrok URL for local development on port 5050).
 * 6. Run installTrigger() once from the Apps Script toolbar to enable automatic
 *    periodic execution every 5 minutes.
 * ============================================================================
 */

const CONFIG = {
  // Replace with your Google Drive Folder ID (found in folder URL after /folders/)
  FOLDER_ID: "YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE",

  // Target Shared Agent Room Ingest Endpoint
  ROOM_WEBHOOK_URL: "http://localhost:5050/api/drive/ingest",

  // Supported MIME types for visual reference ingestion
  SUPPORTED_MIME_TYPES: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/svg+xml"
  ],

  // Max images to process in one execution cycle to respect execution timeouts
  BATCH_LIMIT: 10,

  // Script Properties storage key for deduplication
  CACHE_KEY: "PROCESSED_DRIVE_FILE_IDS"
};

/**
 * Main scheduled monitor function.
 * Scans the target folder for uningested images and sends them to the agent room.
 */
function monitorDriveFolder() {
  Logger.log("Starting Google Drive Ingestion monitor check...");

  if (!CONFIG.FOLDER_ID || CONFIG.FOLDER_ID === "YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE") {
    Logger.log("ERROR: Please configure a valid CONFIG.FOLDER_ID before running.");
    return;
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  } catch (e) {
    Logger.log("ERROR: Unable to locate folder with ID: " + CONFIG.FOLDER_ID + " - " + e.message);
    return;
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const rawCache = scriptProperties.getProperty(CONFIG.CACHE_KEY);
  let processedIds = rawCache ? JSON.parse(rawCache) : {};

  let filesProcessed = 0;

  CONFIG.SUPPORTED_MIME_TYPES.forEach(function(mimeType) {
    if (filesProcessed >= CONFIG.BATCH_LIMIT) return;

    const files = folder.getFilesByType(mimeType);

    while (files.hasNext() && filesProcessed < CONFIG.BATCH_LIMIT) {
      const file = files.next();
      const fileId = file.getId();

      // Skip already processed images
      if (processedIds[fileId]) {
        continue;
      }

      const fileName = file.getName();
      const fileSize = file.getSize();
      Logger.log("Processing new image: " + fileName + " (" + fileSize + " bytes, ID: " + fileId + ")");

      try {
        const blob = file.getBlob();
        const base64Data = Utilities.base64Encode(blob.getBytes());

        const payload = {
          file_id: fileId,
          file_name: fileName,
          mime_type: blob.getContentType(),
          image_base64: base64Data,
          metadata: {
            source: "GoogleDrive_AppsScript_Ingest",
            created_at: file.getDateCreated().toISOString(),
            last_updated: file.getLastUpdated().toISOString(),
            description: file.getDescription() || "",
            file_size_bytes: fileSize,
            drive_folder_id: CONFIG.FOLDER_ID
          }
        };

        const response = sendToAgentRoomWebhook(payload);

        if (response && (response.status === "success" || response.task_id)) {
          Logger.log("Successfully ingested: " + fileName + " -> Task ID: " + response.task_id);
          processedIds[fileId] = {
            ingested_at: new Date().toISOString(),
            file_name: fileName,
            task_id: response.task_id
          };
          filesProcessed++;
        } else {
          Logger.log("Webhook rejected image " + fileName + ": " + JSON.stringify(response));
        }

      } catch (err) {
        Logger.log("Failed to process file " + fileName + ": " + err.message);
      }
    }
  });

  // Save updated cache
  scriptProperties.setProperty(CONFIG.CACHE_KEY, JSON.stringify(processedIds));
  Logger.log("Ingestion cycle complete. Processed " + filesProcessed + " new files.");
}

/**
 * Dispatches the HTTP POST payload to the Shared Agent Room microservice.
 */
function sendToAgentRoomWebhook(payload) {
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(CONFIG.ROOM_WEBHOOK_URL, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode >= 200 && responseCode < 300) {
    try {
      return JSON.parse(responseText);
    } catch (e) {
      return { status: "success", raw: responseText };
    }
  } else {
    throw new Error("HTTP " + responseCode + ": " + responseText);
  }
}

/**
 * Installs a time-driven trigger to run monitorDriveFolder every 5 minutes.
 */
function installTrigger() {
  uninstallTriggers(); // Avoid duplicate triggers

  ScriptApp.newTrigger("monitorDriveFolder")
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log("Installed 5-minute automated ingestion trigger.");
}

/**
 * Removes existing time-driven triggers for monitorDriveFolder.
 */
function uninstallTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "monitorDriveFolder") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  Logger.log("Cleared existing triggers.");
}

/**
 * Utility function to reset the processed files cache.
 * Useful when re-ingesting previous assets is desired.
 */
function resetIngestedHistory() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.CACHE_KEY);
  Logger.log("Cleared ingestion history cache.");
}

/**
 * Test function to verify webhook connectivity with a dummy 1x1 PNG.
 */
function testWebhookConnection() {
  Logger.log("Testing webhook connection to " + CONFIG.ROOM_WEBHOOK_URL + "...");

  // 1x1 transparent PNG base64
  const testBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  
  const testPayload = {
    file_id: "test_probe_" + new Date().getTime(),
    file_name: "webhook_probe_test.png",
    mime_type: "image/png",
    image_base64: testBase64,
    metadata: {
      source: "AppsScript_Connection_Probe",
      probe_time: new Date().toISOString()
    }
  };

  try {
    const res = sendToAgentRoomWebhook(testPayload);
    Logger.log("Connection SUCCESS! Result: " + JSON.stringify(res));
  } catch (err) {
    Logger.log("Connection FAILED: " + err.message);
  }
}
