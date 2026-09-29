import UIKit
import Capacitor

// The app's web view controller (Main.storyboard points here instead of Capacitor's own).
// Only change: the iPhone edge-swipe goes BACK through the site's history, like Safari —
// the client found Back couldn't return to the previous screen (2026-09-29). The site records
// every tab, album sheet and Now Playing as a history entry (public/js/mobile/router.js), so a
// swipe steps back one screen; at the first screen there is nothing to go back to and it stays.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }
}
