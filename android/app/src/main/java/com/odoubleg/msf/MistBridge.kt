package com.odoubleg.msf

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.mist.android.BatteryUsage
import com.mist.android.ErrorType
import com.mist.android.IndoorLocationCallback
import com.mist.android.IndoorLocationManager
import com.mist.android.MistEvent
import com.mist.android.Position
import com.mist.android.external.config.LogLevel
import com.mist.android.external.config.MistConfiguration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Runs the Juniper Mist location SDK and reports to the web page:
 *   page → native: MSFNative.startLocation(), stopLocation(), route(x, y)   (meters on the current Mist map)
 *   native → page: window.msfNative.onLocation(x, y, mapId), onRoute(json), onStatus(text), onError(text)
 * The SDK secret and org id come from {BASE_URL}/api/app-config, so they can change without a new build.
 */
class MistBridge(
    private val activity: AppCompatActivity,
    private val webView: WebView,
) : IndoorLocationCallback {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val manager = IndoorLocationManager
    private var wanted = false    // the page asked for location (map tab open)
    private var running = false
    private var config: MistConfiguration? = null

    private val permissions = buildList {
        add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_SCAN)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
    }.toTypedArray()

    private val permissionLauncher = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.all { it }) start()
        else js("onStatus", "Allow location and nearby devices in Settings to see where you are on the map.")
    }

    private val bluetoothLauncher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (bluetoothOn()) start() else js("onStatus", "Turn on Bluetooth to see where you are on the map.")
    }

    // ---------- called from the page ----------

    @JavascriptInterface
    fun startLocation() {
        activity.runOnUiThread {
            wanted = true
            start()
        }
    }

    @JavascriptInterface
    fun stopLocation() {
        activity.runOnUiThread {
            wanted = false
            stop()
        }
    }

    @JavascriptInterface
    fun route(x: Double, y: Double) {
        scope.launch {
            val nodes = withContext(Dispatchers.Default) {
                try {
                    manager.getWayFindingPathTo(Position(x, y))
                } catch (e: Exception) {
                    Log.w(TAG, "wayfinding failed", e)
                    emptyList()
                }
            }
            val out = JSONArray()
            nodes?.forEach { n -> n?.position?.let { out.put(JSONObject().put("x", it.x).put("y", it.y)) } }
            js("onRoute", out.toString())
        }
    }

    // ---------- lifecycle from MainActivity ----------

    fun pageChanged() {
        // A new page load means the map tab is closed until the page asks again.
        wanted = false
        stop()
    }

    fun resume() {
        if (wanted) start()
    }

    fun pause() = stop()

    fun shutdown() {
        stop()
        scope.cancel()
    }

    // ---------- SDK ----------

    private fun start() {
        if (!wanted || running) return
        val missing = permissions.filter { ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            js("onStatus", "Allow location and nearby devices to see where you are.")
            permissionLauncher.launch(missing.toTypedArray())
            return
        }
        if (!bluetoothOn()) {
            js("onStatus", "Bluetooth is off.")
            try {
                bluetoothLauncher.launch(Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_ENABLE))
            } catch (e: SecurityException) {
                js("onStatus", "Turn on Bluetooth to see where you are on the map.")
            }
            return
        }
        scope.launch {
            val cfg = config ?: loadConfig() ?: return@launch
            config = cfg
            if (!wanted || running) return@launch
            try {
                manager.start(cfg, this@MistBridge)
                running = true
                js("onStatus", "Finding your location…")
            } catch (e: Exception) {
                Log.e(TAG, "Mist start failed", e)
                js("onError", "Indoor location could not start.")
            }
        }
    }

    private fun stop() {
        if (!running) return
        running = false
        try {
            manager.stop()
        } catch (e: Exception) {
            Log.w(TAG, "Mist stop failed", e)
        }
    }

    private suspend fun loadConfig(): MistConfiguration? {
        val json = withContext(Dispatchers.IO) {
            try {
                val conn = URL("${BuildConfig.BASE_URL}/api/app-config").openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
            } catch (e: Exception) {
                Log.w(TAG, "app-config failed", e)
                null
            }
        }
        val m = json?.optJSONObject("mist")
        if (m == null) {
            js("onStatus", "Couldn't reach the fair server for indoor location.")
            return null
        }
        val token = m.optString("token")
        val orgId = m.optString("org_id")
        if (token.isBlank() || orgId.isBlank()) {
            js("onStatus", "Indoor location isn't turned on yet. The map still shows every venue.")
            return null
        }
        return MistConfiguration(
            activity.applicationContext,
            token,
            orgId,
            null,
            LogLevel.WARNING,
            BuildConfig.DEBUG,
            BatteryUsage.HIGH_BATTERY_USAGE_HIGH_ACCURACY,
        )
    }

    override fun onReceiveEvent(event: MistEvent) {
        when (event) {
            is MistEvent.OnRelativeLocationUpdate -> {
                val p = event.point
                activity.runOnUiThread {
                    if (running) webView.evaluateJavascript(
                        "window.msfNative&&window.msfNative.onLocation(${p.x},${p.y},${JSONObject.quote(p.map?.id ?: "")})", null,
                    )
                }
            }
            is MistEvent.OnError -> js("onError", friendly(event.error))
            else -> Unit
        }
    }

    private fun friendly(e: ErrorType): String = when (e) {
        ErrorType.invalidToken, ErrorType.incorrectOrgId, ErrorType.failedToEnroll -> "Indoor location isn't set up correctly (Mist SDK secret)."
        ErrorType.noBleFound, ErrorType.noMistBeacon -> "No fair Wi-Fi beacons nearby. Indoor location works inside buildings with Mist access points."
        ErrorType.notConnected, ErrorType.unknownHost -> "No internet connection for indoor location."
        ErrorType.mapDataNotAvailable -> "The map for this building isn't available."
        else -> "Indoor location problem: $e"
    }

    private fun bluetoothOn(): Boolean {
        val bm = activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return bm?.adapter?.isEnabled == true
    }

    private fun js(fn: String, arg: String) {
        activity.runOnUiThread {
            webView.evaluateJavascript("window.msfNative&&window.msfNative.$fn(${JSONObject.quote(arg)})", null)
        }
    }

    companion object {
        private const val TAG = "MistBridge"
    }
}
