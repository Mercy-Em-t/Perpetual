package cloud.missperpetual.tillforwarder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.telephony.SmsMessage;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * SmsReceiver.java (v2.5.0)
 * =========================
 * Autonomous Dual-Channel SMS Forwarder for Redmi Note 12.
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
        if (intent == null || !"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;

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

        enqueueMessage(context, fromAddr, messageText, System.currentTimeMillis());
        flushQueueAsync(context, null);
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
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String rawQueue = prefs.getString("offline_queue", "[]");
            JSONArray queue = new JSONArray(rawQueue);
            JSONObject item = new JSONObject();
            item.put("from", from);
            item.put("sim", "REDMI_NOTE_12");
            item.put("text", text);
            item.put("timestamp", timestamp);
            queue.put(item);
            prefs.edit().putString("offline_queue", queue.toString()).apply();
        } catch (Exception e) {
            Log.e(TAG, "Queue error: " + e.getMessage());
        }
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

                    boolean tillSuccess = true;
                    boolean financeSuccess = true;
                    StringBuilder deliveredVia = new StringBuilder();

                    if (toTill) {
                        tillSuccess = postToEndpoint(tillEndpoint, payload);
                        if (tillSuccess) {
                            deliveredVia.append("Till");
                            prefs.edit().putInt("total_till_sent", prefs.getInt("total_till_sent", 0) + 1).apply();
                        }
                    }

                    if (toFinance) {
                        financeSuccess = postToEndpoint(financeEndpoint, payload);
                        if (financeSuccess) {
                            if (deliveredVia.length() > 0) deliveredVia.append(" + ");
                            deliveredVia.append("Personal Finance");
                            prefs.edit().putInt("total_finance_sent", prefs.getInt("total_finance_sent", 0) + 1).apply();
                        }
                    }

                    if (tillSuccess && financeSuccess) {
                        sentCount++;
                        prefs.edit()
                                .putString("last_forwarded", "[" + from + "] " + text)
                                .putString("last_status", "ONLINE - Dispatched via " + deliveredVia)
                                .putInt("total_sent", prefs.getInt("total_sent", 0) + 1)
                                .apply();
                    } else {
                        remaining.put(item);
                    }
                }

                if (remaining.length() > 0) {
                    prefs.edit().putString("last_status", "OFFLINE QUEUED (" + remaining.length() + " waiting)").apply();
                }
                prefs.edit().putString("offline_queue", remaining.toString()).apply();
                Log.i(TAG, "Flushed queue: sent=" + sentCount + ", pending=" + remaining.length());
            } catch (Exception e) {
                Log.e(TAG, "Flush error: " + e.getMessage());
            } finally {
                if (onComplete != null) onComplete.run();
            }
        }).start();
    }

    public static boolean postToEndpoint(String targetUrl, String jsonPayload) {
        if (targetUrl == null || targetUrl.trim().isEmpty()) return false;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(targetUrl.trim());
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(6000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("User-Agent", "Savannah-Till-Forwarder/2.5.0");
            byte[] bytes = jsonPayload.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            int code = conn.getResponseCode();
            return code >= 200 && code < 300;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
