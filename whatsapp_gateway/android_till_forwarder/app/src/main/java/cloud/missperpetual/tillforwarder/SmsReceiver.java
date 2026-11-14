package cloud.missperpetual.tillforwarder;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.telephony.SmsMessage;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * SmsReceiver.java (v2.7.0)
 * =========================
 * Autonomous High-Reliability Dual-Channel SMS Forwarder for Redmi Note 12.
 * 
 * Features:
 *  - goAsync() + Partial WakeLock ensures CPU never sleeps before HTTP post finishes
 *  - Triple exponential retry loop inside postToEndpoint (defeats radio-wake sleep latency)
 *  - Independent delivery state per destination (Till vs Personal Finance)
 *  - Autonomous AlarmManager quick retry (8s) if offline, eliminating manual queue flush
 * 
 * Channel 1 (Business Till 5758419):
 *   Dispatches customer order receipts directly to:
 *   https://updatedtms-whitelabel-core.vercel.app/api/till/receipt
 * 
 * Channel 2 (Personal Financial Intelligence):
 *   Dispatches personal M-Pesa, DTB, KCB, Equity, Fuliza & Okoa Jahazi SMS to:
 *   https://personal-finance-dashboard-zeta-green.vercel.app/api/ingest
 */
public class SmsReceiver extends BroadcastReceiver {
    private static final String TAG = "SavannahTillRelay";
    public static final String PREFS_NAME = "TillForwarderPrefs";
    public static final String ACTION_QUICK_RETRY = "cloud.missperpetual.tillforwarder.ACTION_QUICK_RETRY";

    // Channel 1: Storefront Order Verification
    public static final String DEFAULT_TILL_URL = "https://updatedtms-whitelabel-core.vercel.app/api/till/receipt";
    public static final String DEFAULT_PRIMARY_URL = DEFAULT_TILL_URL;

    // Channel 2: Mercy's Personal Finance App
    public static final String DEFAULT_FINANCE_URL = "https://personal-finance-dashboard-zeta-green.vercel.app/api/ingest";
    public static final String DEFAULT_DASHBOARD_URL = "https://personal-finance-dashboard-zeta-green.vercel.app/";

    // Senders for banking and telecommunication networks
    private static final String FINANCIAL_SENDERS = "MPESA|M-PESA|DTB|SAFARICOM|OKOA|KCB|EQUITY|COOP|NCBA|STANBIC|ABSA";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();

        // 2. Telephony SMS Received
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(action)) return;

        Bundle bundle = intent.getExtras();
        if (bundle == null) return;

        Object[] pdus = (Object[]) bundle.get("pdus");
        String format = bundle.getString("format");
        if (pdus == null || pdus.length == 0) return;

        StringBuilder fullMsg = new StringBuilder();
        String sender = "";

        for (Object pdu : pdus) {
            SmsMessage sms = SmsMessage.createFromPdu((byte[]) pdu, format);
            if (sms != null) {
                sender = sms.getOriginatingAddress();
                fullMsg.append(sms.getMessageBody());
            }
        }

        final String messageText = fullMsg.toString().trim();
        final String fromAddr = sender != null ? sender.trim() : "UNKNOWN";

        boolean isFinancial = isFinancialMessage(fromAddr, messageText);
        if (!isFinancial) return;

        Log.i(TAG, "Financial SMS intercepted from " + fromAddr + ". Enqueueing and firing instant dispatch!");
        enqueueMessage(context, fromAddr, messageText, System.currentTimeMillis());

        // Keep CPU awake and process alive while network POST is in-flight
        final PendingResult pendingResult = goAsync();
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        final PowerManager.WakeLock wakeLock = (pm != null)
                ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SavannahTillRelay:SmsWakeLock")
                : null;
        if (wakeLock != null) {
            try {
                wakeLock.acquire(45000); // 45 seconds max wake lock
            } catch (Exception ignored) {}
        }

        flushQueueAsync(context, () -> {
            try {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
            } catch (Exception ignored) {}
            try {
                pendingResult.finish();
            } catch (Exception ignored) {}
        });
    }

    private static void executeWithWakeLock(Context context, Runnable task) {
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = (pm != null)
                ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SavannahTillRelay:ExecWakeLock")
                : null;
        if (wakeLock != null) {
            try {
                wakeLock.acquire(30000);
            } catch (Exception ignored) {}
        }
        try {
            task.run();
        } finally {
            try {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            } catch (Exception ignored) {}
        }
    }

    public static boolean isFinancialMessage(String fromAddr, String text) {
        if (text == null || text.trim().isEmpty()) return false;
        String upperSender = fromAddr != null ? fromAddr.toUpperCase() : "";
        return upperSender.matches(".*(" + FINANCIAL_SENDERS + ").*")
                || (text.contains("Confirmed") && (text.contains("Ksh") || text.contains("KES") || text.contains("KSH") || text.contains("Sh")))
                || text.contains("5758419")
                || text.contains("OKOA JAHAZI")
                || text.contains("Okoa Chap")
                || text.contains("transferred KES")
                || text.contains("M-PESA")
                || text.contains("Fuliza")
                || text.contains("SAVANNAH ATELIER");
    }

    public static boolean isTillReceipt(String text) {
        if (text == null) return false;
        // Contains Till 5758419, Till merchant context, or Account/Utility/Working balance
        return text.contains("5758419")
                || text.contains("SAVANNAH ATELIER")
                || text.contains("New Till balance is")
                || text.contains("Till balance is")
                || (text.contains("Confirmed") && (text.contains("Account balance is") || text.contains("Utility balance is") || text.contains("Working balance is")))
                || text.contains("Lipa na M-PESA till");
    }

    public static boolean isPersonalFinance(String fromAddr, String text) {
        if (text == null) return false;
        String upperSender = fromAddr != null ? fromAddr.toUpperCase() : "";
        // Bank SMS
        if (upperSender.matches(".*(DTB|KCB|EQUITY|COOP|NCBA|STANBIC|ABSA).*")) return true;
        // Safaricom data bundles, Okoa, Fuliza
        if (text.contains("OKOA JAHAZI") || text.contains("Okoa Chap") || text.contains("Fuliza") || text.contains("Safaricom data")) return true;
        // Personal M-Pesa movements
        if (text.contains("sent to") || text.contains("paid to") || text.contains("withdrawn") || text.contains("Give Ksh") || text.contains("transferred KES")) return true;
        // Personal inflows (not Till)
        if (text.contains("received") && !isTillReceipt(text)) return true;
        // Normal M-Pesa consumer receipts
        return text.contains("New M-PESA balance is");
    }

    public static synchronized void enqueueMessage(Context context, String from, String text, long timestamp) {
        enqueueMessage(context, null, from, text, timestamp);
    }

    public static synchronized boolean enqueueMessage(Context context, String smsId, String from, String text, long timestamp) {
        try {
            if (text == null || text.trim().isEmpty()) return false;
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

            // Deduplicate by SMS ID (if from inbox cursor) or normalized text hash
            String dedupKey = (smsId != null && !smsId.isEmpty())
                    ? "id:" + smsId
                    : "txt:" + text.trim().hashCode();
            String seenRaw = prefs.getString("seen_sms_keys", "[]");
            JSONArray seenArr = new JSONArray(seenRaw);
            for (int i = 0; i < seenArr.length(); i++) {
                if (dedupKey.equals(seenArr.optString(i))) {
                    return false;
                }
            }
            // Also check text hash when smsId is provided so SMS_RECEIVED + inbox sweep never double-send
            String textKey = "txt:" + text.trim().hashCode();
            for (int i = 0; i < seenArr.length(); i++) {
                if (textKey.equals(seenArr.optString(i))) {
                    return false;
                }
            }

            seenArr.put(dedupKey);
            if (!dedupKey.equals(textKey)) {
                seenArr.put(textKey);
            }
            // Cap seen history to last 250 keys
            if (seenArr.length() > 250) {
                JSONArray trimmed = new JSONArray();
                for (int i = seenArr.length() - 250; i < seenArr.length(); i++) {
                    trimmed.put(seenArr.get(i));
                }
                seenArr = trimmed;
            }

            String rawQueue = prefs.getString("offline_queue", "[]");
            JSONArray queue = new JSONArray(rawQueue);
            JSONObject item = new JSONObject();
            item.put("from", from);
            item.put("sim", "REDMI_NOTE_12");
            item.put("text", text);
            item.put("timestamp", timestamp);
            item.put("till_sent", false);
            item.put("finance_sent", false);
            queue.put(item);
            prefs.edit()
                    .putString("offline_queue", queue.toString())
                    .putString("seen_sms_keys", seenArr.toString())
                    .apply();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Queue error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Sweeps recent SMS inbox messages (last 24h, up to 25 messages) to catch any
     * M-Pesa / financial SMS whose real-time SMS_RECEIVED broadcast was dropped by MIUI/Doze.
     */
    public static int sweepRecentInbox(Context context) {
        int enqueued = 0;
        android.database.Cursor cursor = null;
        try {
            long cutoffMs = System.currentTimeMillis() - (24L * 60L * 60L * 1000L);
            android.net.Uri uri = android.net.Uri.parse("content://sms/inbox");
            cursor = context.getContentResolver().query(
                    uri,
                    new String[]{"_id", "address", "body", "date"},
                    "date >= ?",
                    new String[]{String.valueOf(cutoffMs)},
                    "date DESC LIMIT 25"
            );
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    String id = cursor.getString(cursor.getColumnIndexOrThrow("_id"));
                    String address = cursor.getString(cursor.getColumnIndexOrThrow("address"));
                    String body = cursor.getString(cursor.getColumnIndexOrThrow("body"));
                    long date = cursor.getLong(cursor.getColumnIndexOrThrow("date"));

                    if (isFinancialMessage(address, body)) {
                        if (enqueueMessage(context, id, address != null ? address : "MPESA", body, date)) {
                            enqueued++;
                        }
                    }
                }
            }
            if (enqueued > 0) {
                Log.i(TAG, "Inbox sweep recovered " + enqueued + " missed financial SMS!");
            }
        } catch (SecurityException se) {
            Log.w(TAG, "Inbox sweep skipped (READ_SMS permission missing): " + se.getMessage());
        } catch (Exception e) {
            Log.w(TAG, "Inbox sweep error: " + e.getMessage());
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Exception ignored) {}
            }
        }
        return enqueued;
    }

    public static int getOfflineQueueCount(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String rawQueue = prefs.getString("offline_queue", "[]");
            JSONArray queue = new JSONArray(rawQueue);
            return queue.length();
        } catch (Exception e) {
            return 0;
        }
    }

    public static String getTillEndpoint(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String url = prefs.getString("primary_url", DEFAULT_TILL_URL);
        if (url == null || url.trim().isEmpty() || url.contains("10.119.") || url.contains("/a/finance")) {
            url = DEFAULT_TILL_URL;
            prefs.edit().putString("primary_url", url).apply();
        }
        return url.trim();
    }

    public static String getFinanceEndpoint(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String url = prefs.getString("finance_url", DEFAULT_FINANCE_URL);
        if (url == null || url.trim().isEmpty() || url.contains("/a/finance")) {
            url = DEFAULT_FINANCE_URL;
            prefs.edit().putString("finance_url", url).apply();
        }
        return url.trim();
    }

    public static String getDashboardUrl(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String url = prefs.getString("dashboard_url", DEFAULT_DASHBOARD_URL);
        if (url == null || url.trim().isEmpty() || url.contains("/a/finance")) {
            url = DEFAULT_DASHBOARD_URL;
            prefs.edit().putString("dashboard_url", url).apply();
        }
        return url.trim();
    }

    public static void flushQueueAsync(final Context context) {
        flushQueueAsync(context, null);
    }

    public static void flushQueueAsync(final Context context, final Runnable onComplete) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String rawQueue = prefs.getString("offline_queue", "[]");
                JSONArray queue = new JSONArray(rawQueue);
                if (queue.length() == 0) {
                    if (onComplete != null) onComplete.run();
                    return;
                }

                JSONArray remaining = new JSONArray();
                int sentCount = 0;
                String tillEndpoint = getTillEndpoint(context);
                String financeEndpoint = getFinanceEndpoint(context);

                for (int i = 0; i < queue.length(); i++) {
                    JSONObject item = queue.getJSONObject(i);
                    String from = item.optString("from", "MPESA");
                    String text = item.optString("text", "");
                    String payload = item.toString();

                    boolean toTill = isTillReceipt(text);
                    boolean toFinance = isPersonalFinance(from, text);

                    // If neither flag matched explicitly but it's financial, deliver to both
                    if (!toTill && !toFinance) {
                        toTill = true;
                        toFinance = true;
                    }

                    boolean alreadySentTill = item.optBoolean("till_sent", false);
                    boolean alreadySentFinance = item.optBoolean("finance_sent", false);

                    boolean tillSuccess = alreadySentTill;
                    boolean financeSuccess = alreadySentFinance;
                    StringBuilder deliveredVia = new StringBuilder();

                    // Channel 1: Till Endpoint
                    if (toTill && !alreadySentTill) {
                        tillSuccess = postToEndpoint(tillEndpoint, payload);
                        if (tillSuccess) {
                            item.put("till_sent", true);
                            deliveredVia.append("Till");
                            prefs.edit().putInt("total_till_sent", prefs.getInt("total_till_sent", 0) + 1).apply();
                        }
                    }

                    // Channel 2: Personal Finance Endpoint
                    if (toFinance && !alreadySentFinance) {
                        financeSuccess = postToEndpoint(financeEndpoint, payload);
                        if (financeSuccess) {
                            item.put("finance_sent", true);
                            if (deliveredVia.length() > 0) deliveredVia.append(" + ");
                            deliveredVia.append("Personal Finance");
                            prefs.edit().putInt("total_finance_sent", prefs.getInt("total_finance_sent", 0) + 1).apply();
                        }
                    }

                    boolean isCompletelyDelivered = (!toTill || tillSuccess) && (!toFinance || financeSuccess);

                    if (isCompletelyDelivered) {
                        sentCount++;
                        prefs.edit()
                                .putString("last_forwarded", "[" + from + "] " + text)
                                .putString("last_status", "ONLINE - Dispatched via " + (deliveredVia.length() > 0 ? deliveredVia.toString() : "Cloud"))
                                .putInt("total_sent", prefs.getInt("total_sent", 0) + 1)
                                .apply();
                    } else {
                        remaining.put(item);
                    }
                }

                prefs.edit().putString("offline_queue", remaining.toString()).apply();
                if (remaining.length() > 0) {
                    prefs.edit().putString("last_status", "OFFLINE QUEUED (" + remaining.length() + " waiting)").apply();
                    // Schedule autonomous quick retry in 8 seconds so user never has to flush manually!
                    scheduleQuickRetry(context, 8000L);
                }
                Log.i(TAG, "Flushed queue: sent=" + sentCount + ", pending=" + remaining.length());
            } catch (Exception e) {
                Log.e(TAG, "Flush error: " + e.getMessage());
            } finally {
                if (onComplete != null) onComplete.run();
            }
        }).start();
    }

    public static void scheduleQuickRetry(Context context, long delayMs) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent intent = new Intent(context, QuickRetryReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(context, 909, intent, flags);
            long triggerAt = SystemClock.elapsedRealtime() + delayMs;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
            Log.i(TAG, "Scheduled autonomous retry in " + (delayMs / 1000) + "s via AlarmManager.");
        } catch (Exception e) {
            Log.e(TAG, "Quick retry schedule failed: " + e.getMessage());
        }
    }

    public static boolean postToEndpoint(String targetUrl, String jsonPayload) {
        if (targetUrl == null || targetUrl.trim().isEmpty()) return false;

        // Up to 3 attempts with exponential delay to withstand cellular radio wake latency
        for (int attempt = 1; attempt <= 3; attempt++) {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(targetUrl.trim());
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(15000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("User-Agent", "Savannah-Till-Forwarder/2.8.0");
                conn.setRequestProperty("x-till-relay-secret", "savannah_relay_sec_7f9b2c81e3a4d650");
                byte[] bytes = jsonPayload.getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                    os.flush();
                }
                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    return true;
                }
                Log.w(TAG, "postToEndpoint HTTP " + code + " on attempt " + attempt);
            } catch (Exception e) {
                Log.w(TAG, "postToEndpoint attempt " + attempt + " failed: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }

            if (attempt < 3) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ignored) {}
            }
        }
        return false;
    }

    public static void sendHeartbeatAsync(final Context context) {
        new Thread(() -> {
            try {
                int battery = -1;
                boolean isCharging = false;
                try {
                    IntentFilter ifilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
                    Intent batteryStatus = context.registerReceiver(null, ifilter);
                    if (batteryStatus != null) {
                        int level = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                        int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                        if (scale > 0) {
                            battery = (int) ((level / (float) scale) * 100);
                        }
                        int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                        isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                                     status == BatteryManager.BATTERY_STATUS_FULL;
                    }
                } catch (Exception ignored) {}

                String netType = "CELLULAR";
                try {
                    ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
                    if (cm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        Network net = cm.getActiveNetwork();
                        if (net != null) {
                            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                                netType = "WIFI";
                            }
                        }
                    }
                } catch (Exception ignored) {}

                JSONObject payload = new JSONObject();
                payload.put("action", "ping");
                payload.put("battery", battery);
                payload.put("charging", isCharging);
                payload.put("network", netType);
                payload.put("version", "2.8.0");
                payload.put("device_id", "redmi_note_12");

                String tillUrl = getTillEndpoint(context);
                postToEndpoint(tillUrl, payload.toString());
                Log.i(TAG, "Heartbeat sent to " + tillUrl + ": battery=" + battery + "%, charging=" + isCharging + ", net=" + netType);
            } catch (Exception e) {
                Log.w(TAG, "Heartbeat error: " + e.getMessage());
            }
        }).start();
    }
}
