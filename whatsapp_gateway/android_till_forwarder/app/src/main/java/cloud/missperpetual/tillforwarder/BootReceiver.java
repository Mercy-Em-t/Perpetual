package cloud.missperpetual.tillforwarder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;

/**
 * BootReceiver.java
 * =================
 * Automatically executes when the phone powers on or restarts.
 * 1. Sweeps any SMS that arrived during power-on.
 * 2. Flushes the offline queue to the cloud webhook.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "SavannahBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        Log.i(TAG, "Device booted! Sweeping inbox and flushing offline queue...");

        new Thread(() -> {
            try {
                Uri uri = Uri.parse("content://sms");
                Cursor cursor = context.getContentResolver().query(
                        uri,
                        new String[]{"_id", "address", "body", "date"},
                        null,
                        null,
                        "date DESC LIMIT 25"
                );
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        String address = cursor.getString(cursor.getColumnIndexOrThrow("address"));
                        String body = cursor.getString(cursor.getColumnIndexOrThrow("body"));
                        long date = cursor.getLong(cursor.getColumnIndexOrThrow("date"));

                        if (body != null && (body.contains("Confirmed") || body.contains("5758419")) && (body.contains("Ksh") || body.contains("KES") || body.contains("KSH"))) {
                            SmsReceiver.enqueueMessage(context, address != null ? address : "MPESA", body, date);
                        }
                    }
                    cursor.close();
                }
            } catch (Exception e) {
                Log.e(TAG, "Boot inbox sweep error: " + e.getMessage());
            }

            SmsReceiver.sendHeartbeatAsync(context);
            SmsReceiver.flushQueueAsync(context, null);
            HeartbeatReceiver.scheduleNext(context);
        }).start();
    }
}
