package cloud.missperpetual.financeapp;

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
 * SmsReceiver.java
 * ================
 * Autonomous Background BroadcastReceiver for Mercy's Personal Finance App.
 * Captures M-Pesa, DTB, KCB, Equity, Safaricom Data, Okoa Jahazi, and Fuliza SMS,
 * stores them locally on the phone when offline, and syncs to both:
 *   - Standalone Finance App (:5180/api/ingest)
 *   - Perpetual Suite Gateway (:5174/api/finance/ingest)
 */
public class SmsReceiver extends BroadcastReceiver {
    private static final String TAG = "MercyFinanceReceiver";
    private static final String FINANCIAL_SENDERS = "MPESA|M-PESA|DTB|SAFARICOM|OKOA|FULIZA|KCB|EQUITY|COOP|NCBA";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;

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
        final String fromAddr = sender != null ? sender.trim() : "MPESA";

        boolean isFinancial = fromAddr.toUpperCase().matches(".*(" + FINANCIAL_SENDERS + ").*")
                || (messageText.contains("Confirmed") && (messageText.contains("Ksh") || messageText.contains("KES")))
                || messageText.contains("OKOA JAHAZI")
                || messageText.contains("Fuliza M-PESA")
                || messageText.contains("transferred KES");

        if (!isFinancial) return;

        enqueueMessage(context, fromAddr, messageText, System.currentTimeMillis());
        flushQueueAsync(context);
    }

    public static synchronized void enqueueMessage(Context context, String from, String text, long timestamp) {
        try {
            SharedPreferences prefs = context.getSharedPreferences("MercyFinancePrefs", Context.MODE_PRIVATE);
            String rawQueue = prefs.getString("offline_finance_queue", "[]");
            JSONArray queue = new JSONArray(rawQueue);
            JSONObject item = new JSONObject();
            item.put("from", from);
            item.put("text", text);
            item.put("timestamp", timestamp);
            queue.put(item);
            prefs.edit().putString("offline_finance_queue", queue.toString()).apply();
        } catch (Exception e) {
            Log.e(TAG, "Queue error: " + e.getMessage());
        }
    }

    public static void flushQueueAsync(final Context context) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences("MercyFinancePrefs", Context.MODE_PRIVATE);
                String[] endpoints = new String[]{
                        prefs.getString("primary_ingest", "http://192.168.100.32:5180/api/ingest"),
                        prefs.getString("tailscale_ingest", "http://100.111.211.80:5180/api/ingest"),
                        prefs.getString("suite_ingest", "http://192.168.100.32:5174/api/finance/ingest")
                };

                String rawQueue = prefs.getString("offline_finance_queue", "[]");
                JSONArray queue = new JSONArray(rawQueue);
                if (queue.length() == 0) return;

                JSONArray remaining = new JSONArray();
                for (int i = 0; i < queue.length(); i++) {
                    JSONObject item = queue.getJSONObject(i);
                    String payload = item.toString();
                    boolean delivered = false;
                    for (String ep : endpoints) {
                        if (postJson(ep, payload)) {
                            delivered = true;
                            break;
                        }
                    }
                    if (!delivered) {
                        remaining.put(item);
                    }
                }
                prefs.edit().putString("offline_finance_queue", remaining.toString()).apply();
            } catch (Exception e) {
                Log.e(TAG, "Flush error: " + e.getMessage());
            }
        }).start();
    }

    public static boolean postJson(String targetUrl, String jsonPayload) {
        if (targetUrl == null || targetUrl.trim().isEmpty()) return false;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(targetUrl.trim());
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(3500);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
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
