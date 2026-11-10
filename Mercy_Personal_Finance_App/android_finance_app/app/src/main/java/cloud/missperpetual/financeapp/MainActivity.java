package cloud.missperpetual.financeapp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * MainActivity.java
 * =================
 * Standalone Native Android App for Mercy's Personal Finance App.
 * - Loads the full interactive Personal Finance Dashboard via WebView from:
 *     1. Home Wi-Fi: http://192.168.100.32:5180
 *     2. Tailscale VPN: http://100.111.211.80:5180
 *     3. Local Offline Fallback UI if completely disconnected
 * - Exposes a JavascriptInterface ("AndroidFinanceBridge") so the UI can read
 *   the Redmi Note 12 SMS inbox directly on-device and flush offline queues!
 */
public class MainActivity extends Activity {
    private WebView webView;
    private static final String DEFAULT_WIFI_URL = "http://192.168.100.32:5180";
    private static final String DEFAULT_TAILSCALE_URL = "http://100.111.211.80:5180";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                        Manifest.permission.RECEIVE_SMS,
                        Manifest.permission.READ_SMS
                }, 201);
            }
        }

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.addJavascriptInterface(new AndroidFinanceBridge(this), "AndroidFinanceBridge");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl.startsWith(DEFAULT_WIFI_URL)) {
                    view.loadUrl(DEFAULT_TAILSCALE_URL);
                }
            }
        });

        setContentView(webView);

        // Flush any queued offline financial SMS on launch
        SmsReceiver.flushQueueAsync(this);

        SharedPreferences prefs = getSharedPreferences("MercyFinancePrefs", Context.MODE_PRIVATE);
        String startUrl = prefs.getString("dashboard_url", DEFAULT_WIFI_URL);
        webView.loadUrl(startUrl);
    }

    public class AndroidFinanceBridge {
        private final Context ctx;

        AndroidFinanceBridge(Context ctx) {
            this.ctx = ctx;
        }

        @JavascriptInterface
        public String scanLocalPhoneSms(int limit) {
            JSONArray results = new JSONArray();
            try {
                Uri uri = Uri.parse("content://sms/inbox");
                Cursor cursor = ctx.getContentResolver().query(
                        uri,
                        new String[]{"_id", "address", "date", "body"},
                        null,
                        null,
                        "date DESC LIMIT " + Math.max(10, Math.min(limit, 300))
                );
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        JSONObject obj = new JSONObject();
                        obj.put("id", cursor.getLong(0));
                        obj.put("from", cursor.getString(1));
                        obj.put("timestamp", cursor.getLong(2));
                        obj.put("text", cursor.getString(3));
                        results.put(obj);
                    }
                    cursor.close();
                }
            } catch (Exception ignored) {}
            return results.toString();
        }

        @JavascriptInterface
        public void syncNow() {
            SmsReceiver.flushQueueAsync(ctx);
            runOnUiThread(() -> Toast.makeText(ctx, "Syncing Redmi Note 12 SMS with Finance Server (:5180 & :5174)...", Toast.LENGTH_SHORT).show());
        }
    }
}
