const { AddonManagerPrivate } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm"
);

const { AddonTestUtils } = ChromeUtils.import(
  "resource://testing-common/AddonTestUtils.jsm"
);

AddonTestUtils.initMochitest(this);
AddonTestUtils.hookAMTelemetryEvents();

const ID_PERMS = "update_perms@tests.mozilla.org";
const ID_ORIGINS = "update_origins@tests.mozilla.org";
const ID_EXPERIMENT = "experiment_test@tests.mozilla.org";

function getBadgeStatus() {
  let menuButton = document.getElementById("button-appmenu");
  return menuButton.getAttribute("badge-status");
}

// Set some prefs that apply to all the tests in this file
add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      // We don't have pre-pinned certificates for the local mochitest server
      ["extensions.install.requireBuiltInCerts", false],
      ["extensions.update.requireBuiltInCerts", false],
      // Don't require the extensions to be signed
      ["xpinstall.signatures.required", false],
    ],
  });
});

// Helper function to test an upgrade that should not show a prompt
async function testNoPrompt(origUrl, id) {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Turn on background updates
      ["extensions.update.enabled", true],

      // Point updates to the local mochitest server
      [
        "extensions.update.background.url",
        `${BASE}/browser_webext_update.json`,
      ],
    ],
  });

  // Install version 1.0 of the test extension
  let addon = await promiseInstallAddon(origUrl);

  ok(addon, "Addon was installed");

  let sawPopup = false;
  PopupNotifications.panel.addEventListener(
    "popupshown",
    () => (sawPopup = true),
    { once: true }
  );

  // Trigger an update check and wait for the update to be applied.
  let updatePromise = waitForUpdate(addon);
  AddonManagerPrivate.backgroundUpdateCheck();
  await updatePromise;

  // There should be no notifications about the update
  is(getBadgeStatus(), "", "Should not have addon alert badge");

  await gCUITestUtils.openMainMenu();
  let addons = PanelUI.addonNotificationContainer;
  is(addons.children.length, 0, "Have 0 updates in the PanelUI menu");
  await gCUITestUtils.hideMainMenu();

  ok(!sawPopup, "Should not have seen permissions notification");

  addon = await AddonManager.getAddonByID(id);
  is(addon.version, "2.0", "Update should have applied");

  await addon.uninstall();
  await SpecialPowers.popPrefEnv();

  // Test that the expected telemetry events have been recorded (and that they do not
  // include the permission_prompt event).
  const amEvents = AddonTestUtils.getAMTelemetryEvents();
  const updateEventsSteps = amEvents
    .filter(evt => {
      return evt.method === "update" && evt.extra && evt.extra.addon_id == id;
    })
    .map(evt => {
      return evt.extra.step;
    });

  // Expect telemetry events related to a completed update with no permissions_prompt event.
  Assert.deepEqual(
    updateEventsSteps,
    ["started", "download_started", "download_completed", "completed"],
    "Got the steps from the collected telemetry events"
  );
}

// Test that an update that adds new non-promptable permissions is just
// applied without showing a notification dialog.
add_task(() =>
  testNoPrompt(`${BASE}/browser_webext_update_perms1.xpi`, ID_PERMS)
);

// Test that an update that narrows origin permissions is just applied without
// showing a notification prompt
add_task(() =>
  testNoPrompt(`${BASE}/browser_webext_update_origins1.xpi`, ID_ORIGINS)
);

// Test that an Experiment is not prompting for additional permissions.
add_task(() =>
  testNoPrompt(`${BASE}/browser_webext_experiment.xpi`, ID_EXPERIMENT)
);
