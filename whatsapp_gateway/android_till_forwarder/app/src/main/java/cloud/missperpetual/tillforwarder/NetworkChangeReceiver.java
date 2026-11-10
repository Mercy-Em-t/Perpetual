package cloud.missperpetual.tillforwarder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.Build;
import android.util.Log;

/**
 * NetworkChangeReceiver.java
 * ===========================
 * Listens for CONNECTIVITY_ACTION / Network callbacks.
 * The instant the phone reconnects to Mobile Data (4G/5G) or Wi-Fi,
 * this automatically flushes the entire offline queue to the server with zero delay.
 */
public class NetworkChangeReceiver extends BroadcastReceiver {
    private static final String TAG = "SavannahNetworkRelay";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;

        boolean isConnected = isOnline(context);
        int queueCount = SmsReceiver.getOfflineQueueCount(context);

        Log.i(TAG, "Network change detected! isConnected=" + isConnected + ", queueCount=" + queueCount);

        if (isConnected) {
            SmsReceiver.sendHeartbeatAsync(context);
            if (queueCount > 0) {
                Log.i(TAG, "Online and queue has " + queueCount + " items -> Flushing immediately!");
                SmsReceiver.flushQueueAsync(context, null);
            }
        }
    }

    public static boolean isOnline(Context context) {
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network activeNet = cm.getActiveNetwork();
                if (activeNet == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(activeNet);
                return caps != null && (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            } else {
                NetworkInfo netInfo = cm.getActiveNetworkInfo();
                return netInfo != null && netInfo.isConnected();
            }
        } catch (Exception e) {
            return false;
        }
    }
}
