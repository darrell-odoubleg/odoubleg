package com.odoubleg.msf

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * The schedule and map are the msf.odoubleg.com web pages, shown full screen.
 * Indoor location comes from the Mist SDK through [MistBridge], exposed to the page as window.MSFNative.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var mist: MistBridge
    private val home = Uri.parse(BuildConfig.BASE_URL)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        mist = MistBridge(this, webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(false)
            userAgentString = "$userAgentString MSFApp/${BuildConfig.VERSION_NAME}"
        }
        webView.addJavascriptInterface(mist, "MSFNative")
        webView.addJavascriptInterface(AppBridge(), "MSFApp")
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            // Stay on the fair site; anything else opens in the phone's browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == home.host || url.scheme == "file") return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                mist.pageChanged()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) view.loadUrl("file:///android_asset/offline.html")
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState != null) webView.restoreState(savedInstanceState) else webView.loadUrl(home.toString())
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onStart() {
        super.onStart()
        mist.resume()
    }

    override fun onStop() {
        super.onStop()
        mist.pause()
    }

    override fun onDestroy() {
        mist.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    private inner class AppBridge {
        @JavascriptInterface
        fun retry() {
            runOnUiThread { webView.loadUrl(home.toString()) }
        }
    }
}
