package cloud.missperpetual.tillforwarder;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private EditText tillUrlInput;
    private EditText financeUrlInput;
    private EditText dashboardUrlInput;
    private TextView offlineQueueCountView;
    private TextView totalForwardedCountView;
    private TextView statsView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                        Manifest.permission.RECEIVE_SMS,
                        Manifest.permission.READ_SMS
                }, 101);
            }
        }

        final SharedPreferences prefs = getSharedPreferences(SmsReceiver.PREFS_NAME, Context.MODE_PRIVATE);

        // Sanitize and migrate any legacy or cached URLs
        sanitizePreferences(prefs);

        // Dead-Man's Switch Heartbeat: Dispatch immediately on launch & register self-rescheduling AlarmManager
        try {
            SmsReceiver.sendHeartbeatAsync(this);
            HeartbeatReceiver.scheduleNext(this);
        } catch (Exception e) {
            android.util.Log.w("MainActivity", "Heartbeat schedule error: " + e.getMessage());
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#0F172A"));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(44, 56, 44, 64);

        TextView title = new TextView(this);
        title.setText("SAVANNAH TILL & FINANCE RELAY");
        title.setTextColor(Color.parseColor("#38BDF8"));
        title.setTextSize(20f);
        title.setTypeface(null, Typeface.BOLD);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Dual-Channel Autonomous Bridge (Redmi Note 12 v2.8.0 • Sentinel Active)");
        subtitle.setTextColor(Color.parseColor("#94A3B8"));
        subtitle.setPadding(0, 8, 0, 24);
        root.addView(subtitle);

        // Metrics Row
        LinearLayout metricsRow = new LinearLayout(this);
        metricsRow.setOrientation(LinearLayout.HORIZONTAL);
        metricsRow.setPadding(0, 0, 0, 24);

        LinearLayout queueBox = new LinearLayout(this);
        queueBox.setOrientation(LinearLayout.VERTICAL);
        queueBox.setBackgroundColor(Color.parseColor("#1E293B"));
        queueBox.setPadding(24, 20, 24, 20);
        LinearLayout.LayoutParams boxParams1 = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        boxParams1.setMargins(0, 0, 12, 0);
        queueBox.setLayoutParams(boxParams1);

        TextView queueLbl = new TextView(this);
        queueLbl.setText("Offline Queue");
        queueLbl.setTextColor(Color.parseColor("#94A3B8"));
        queueLbl.setTextSize(12f);
        queueBox.addView(queueLbl);

        offlineQueueCountView = new TextView(this);
        offlineQueueCountView.setText("0");
        offlineQueueCountView.setTextColor(Color.parseColor("#FACC15"));
        offlineQueueCountView.setTextSize(24f);
        offlineQueueCountView.setTypeface(null, Typeface.BOLD);
        queueBox.addView(offlineQueueCountView);

        LinearLayout sentBox = new LinearLayout(this);
        sentBox.setOrientation(LinearLayout.VERTICAL);
        sentBox.setBackgroundColor(Color.parseColor("#1E293B"));
        sentBox.setPadding(24, 20, 24, 20);
        LinearLayout.LayoutParams boxParams2 = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        boxParams2.setMargins(12, 0, 0, 0);
        sentBox.setLayoutParams(boxParams2);

        TextView sentLbl = new TextView(this);
        sentLbl.setText("Total Forwarded");
        sentLbl.setTextColor(Color.parseColor("#94A3B8"));
        sentLbl.setTextSize(12f);
        sentBox.addView(sentLbl);

        totalForwardedCountView = new TextView(this);
        totalForwardedCountView.setText("0");
        totalForwardedCountView.setTextColor(Color.parseColor("#4ADE80"));
        totalForwardedCountView.setTextSize(24f);
        totalForwardedCountView.setTypeface(null, Typeface.BOLD);
        sentBox.addView(totalForwardedCountView);

        metricsRow.addView(queueBox);
        metricsRow.addView(sentBox);
        root.addView(metricsRow);

        // Section 1: Business Till 5758419 Webhook
        TextView lblTill = new TextView(this);
        lblTill.setText("🏬 1. Store Till 5758419 Webhook (Orders):");
        lblTill.setTextColor(Color.parseColor("#38BDF8"));
        lblTill.setTypeface(null, Typeface.BOLD);
        root.addView(lblTill);

        tillUrlInput = new EditText(this);
        tillUrlInput.setText(SmsReceiver.getTillEndpoint(this));
        tillUrlInput.setTextColor(Color.parseColor("#4ADE80"));
        tillUrlInput.setTextSize(13f);
        root.addView(tillUrlInput);

        // Section 2: Personal Finance Cloud Ingestion
        TextView lblFinance = new TextView(this);
        lblFinance.setText("📊 2. Personal Finance Ingest API (Vercel):");
        lblFinance.setTextColor(Color.parseColor("#C084FC"));
        lblFinance.setTypeface(null, Typeface.BOLD);
        lblFinance.setPadding(0, 18, 0, 0);
        root.addView(lblFinance);

        financeUrlInput = new EditText(this);
        financeUrlInput.setText(SmsReceiver.getFinanceEndpoint(this));
        financeUrlInput.setTextColor(Color.parseColor("#E879F9"));
        financeUrlInput.setTextSize(13f);
        root.addView(financeUrlInput);

        // Section 3: Personal Finance Dashboard Link
        TextView lblDash = new TextView(this);
        lblDash.setText("🌐 3. Personal Finance Dashboard URL:");
        lblDash.setTextColor(Color.parseColor("#FDE047"));
        lblDash.setTypeface(null, Typeface.BOLD);
        lblDash.setPadding(0, 18, 0, 0);
        root.addView(lblDash);

        dashboardUrlInput = new EditText(this);
        dashboardUrlInput.setText(SmsReceiver.getDashboardUrl(this));
        dashboardUrlInput.setTextColor(Color.parseColor("#FDE047"));
        dashboardUrlInput.setTextSize(13f);
        root.addView(dashboardUrlInput);

        // Buttons
        LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        btnParams.setMargins(0, 16, 0, 0);

        Button saveBtn = new Button(this);
        saveBtn.setText("💾 Save Configuration");
        saveBtn.setBackgroundColor(Color.parseColor("#334155"));
        saveBtn.setTextColor(Color.WHITE);
        saveBtn.setLayoutParams(btnParams);
        saveBtn.setOnClickListener(v -> {
            saveEndpoints(prefs);
            Toast.makeText(this, "Configuration Saved!", Toast.LENGTH_SHORT).show();
        });
        root.addView(saveBtn);

        Button openDashBtn = new Button(this);
        openDashBtn.setText("🚀 Open Personal Finance Dashboard (Vercel)");
        openDashBtn.setBackgroundColor(Color.parseColor("#7C3AED"));
        openDashBtn.setTextColor(Color.WHITE);
        openDashBtn.setLayoutParams(btnParams);
        openDashBtn.setOnClickListener(v -> {
            saveEndpoints(prefs);
            openFinanceDashboard();
        });
        root.addView(openDashBtn);

        Button syncInboxBtn = new Button(this);
        syncInboxBtn.setText("📥 Sync Today's SMS Inbox (Dual-Dispatch)");
        syncInboxBtn.setBackgroundColor(Color.parseColor("#059669"));
        syncInboxBtn.setTextColor(Color.WHITE);
        syncInboxBtn.setLayoutParams(btnParams);
        syncInboxBtn.setOnClickListener(v -> {
            saveEndpoints(prefs);
            syncInboxSms(true);
        });
        root.addView(syncInboxBtn);

        Button flushBtn = new Button(this);
        flushBtn.setText("🔄 Flush Offline Queue Now");
        flushBtn.setBackgroundColor(Color.parseColor("#0284C7"));
        flushBtn.setTextColor(Color.WHITE);
        flushBtn.setLayoutParams(btnParams);
        flushBtn.setOnClickListener(v -> {
            saveEndpoints(prefs);
            Toast.makeText(this, "Flushing offline queue...", Toast.LENGTH_SHORT).show();
            SmsReceiver.flushQueueAsync(this, () -> runOnUiThread(this::refreshStats));
        });
        root.addView(flushBtn);

        Button testBtn = new Button(this);
        testBtn.setText("🧪 Send Test Receipts (Till & Personal)");
        testBtn.setBackgroundColor(Color.parseColor("#16A34A"));
        testBtn.setTextColor(Color.WHITE);
        testBtn.setLayoutParams(btnParams);
        testBtn.setOnClickListener(v -> {
            saveEndpoints(prefs);
            sendTestReceipts();
        });
        root.addView(testBtn);

        statsView = new TextView(this);
        statsView.setTextColor(Color.parseColor("#94A3B8"));
        statsView.setTextSize(12f);
        statsView.setPadding(0, 28, 0, 0);
        root.addView(statsView);

        scroll.addView(root);
        setContentView(scroll);
        refreshStats();
    }

    private void sanitizePreferences(SharedPreferences prefs) {
        String primary = prefs.getString("primary_url", "");
        if (primary == null || primary.contains("10.119.") || primary.contains("/a/finance") || primary.isEmpty()) {
            prefs.edit().putString("primary_url", SmsReceiver.DEFAULT_TILL_URL).apply();
        }

        String finance = prefs.getString("finance_url", "");
        if (finance == null || finance.contains("/a/finance") || finance.isEmpty()) {
            prefs.edit().putString("finance_url", SmsReceiver.DEFAULT_FINANCE_URL).apply();
        }

        String dash = prefs.getString("dashboard_url", "");
        if (dash == null || dash.contains("/a/finance") || dash.isEmpty()) {
            prefs.edit().putString("dashboard_url", SmsReceiver.DEFAULT_DASHBOARD_URL).apply();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStats();
        syncInboxSms(false);
    }

    private void saveEndpoints(SharedPreferences prefs) {
        prefs.edit()
                .putString("primary_url", tillUrlInput.getText().toString().trim())
                .putString("finance_url", financeUrlInput.getText().toString().trim())
                .putString("dashboard_url", dashboardUrlInput.getText().toString().trim())
                .apply();
    }

    private void refreshStats() {
        SharedPreferences prefs = getSharedPreferences(SmsReceiver.PREFS_NAME, Context.MODE_PRIVATE);
        int totalForwarded = prefs.getInt("total_sent", 0);
        int totalTill = prefs.getInt("total_till_sent", 0);
        int totalFinance = prefs.getInt("total_finance_sent", 0);
        int offlineCount = SmsReceiver.getOfflineQueueCount(this);
        String lastSms = prefs.getString("last_forwarded", "None yet");
        String lastStatus = prefs.getString("last_status", "IDLE - Active Dual-Channel Dispatcher");

        offlineQueueCountView.setText(String.valueOf(offlineCount));
        totalForwardedCountView.setText(String.valueOf(totalForwarded));

        statsView.setText(
                "STATUS: " + lastStatus + "\n" +
                "STORE TILL SENT: " + totalTill + "\n" +
                "PERSONAL FINANCE SENT: " + totalFinance + "\n" +
                "OFFLINE QUEUE COUNT: " + offlineCount + "\n\n" +
                "LAST INTERCEPTED SMS:\n" + lastSms
        );
    }

    private void sendTestReceipts() {
        new Thread(() -> {
            try {
                // 1. Test Till Receipt
                JSONObject tillPayload = new JSONObject();
                tillPayload.put("from", "MPESA");
                tillPayload.put("sim", "REDMI_NOTE_12");
                tillPayload.put("text", "SK79TEST99 Confirmed. on 9/11/26 at 7:35 PM Ksh5.00 received from 254710720949 MERCY TRYPHEN EMURUGAT. New Account balance is Ksh740.00");
                tillPayload.put("timestamp", System.currentTimeMillis());

                boolean tillOk = SmsReceiver.postToEndpoint(SmsReceiver.getTillEndpoint(this), tillPayload.toString());

                // 2. Test Personal Finance SMS
                JSONObject financePayload = new JSONObject();
                financePayload.put("from", "MPESA");
                financePayload.put("sim", "REDMI_NOTE_12");
                financePayload.put("text", "UK9DC1TEST Confirmed. Ksh150.00 paid to Quick Mart. on 9/11/26 at 7:36 PM. New M-PESA balance is Ksh3,433.65.");
                financePayload.put("timestamp", System.currentTimeMillis());

                boolean financeOk = SmsReceiver.postToEndpoint(SmsReceiver.getFinanceEndpoint(this), financePayload.toString());

                runOnUiThread(() -> {
                    refreshStats();
                    Toast.makeText(this, "Till: " + (tillOk ? "✅ OK" : "❌ Fail") + " | Finance: " + (financeOk ? "✅ OK" : "❌ Fail"), Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "Test error: " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }).start();
    }

    private void syncInboxSms(final boolean showToast) {
        if (showToast) {
            Toast.makeText(this, "Scanning inbox for financial SMS...", Toast.LENGTH_SHORT).show();
        }
        new Thread(() -> {
            int enqueued = 0;
            try {
                android.net.Uri uri = android.net.Uri.parse("content://sms");
                android.database.Cursor cursor = getContentResolver().query(
                        uri,
                        new String[]{"_id", "address", "body", "date"},
                        null,
                        null,
                        "date DESC LIMIT 60"
                );
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        String id = cursor.getString(cursor.getColumnIndexOrThrow("_id"));
                        String address = cursor.getString(cursor.getColumnIndexOrThrow("address"));
                        String body = cursor.getString(cursor.getColumnIndexOrThrow("body"));
                        long date = cursor.getLong(cursor.getColumnIndexOrThrow("date"));

                        if (SmsReceiver.isFinancialMessage(address, body)) {
                            if (SmsReceiver.enqueueMessage(this, id, address != null ? address : "MPESA", body, date)) {
                                enqueued++;
                            }
                        }
                    }
                    cursor.close();
                }
                final int finalEnqueued = enqueued;
                runOnUiThread(() -> {
                    if (showToast) {
                        Toast.makeText(this, "Found " + finalEnqueued + " financial messages. Dispatching...", Toast.LENGTH_SHORT).show();
                    }
                    SmsReceiver.flushQueueAsync(this, () -> runOnUiThread(this::refreshStats));
                });
            } catch (Exception e) {
                final String err = e.getMessage();
                if (showToast) {
                    runOnUiThread(() -> Toast.makeText(this, "Inbox scan error: " + err, Toast.LENGTH_LONG).show());
                }
            }
        }).start();
    }

    private void openFinanceDashboard() {
        String dashUrl = SmsReceiver.getDashboardUrl(this);
        Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(dashUrl));
        startActivity(browserIntent);
    }
}
