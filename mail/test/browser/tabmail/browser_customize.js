/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Tests customization features of the tabs toolbar.
 */

"use strict";

var { CustomizeDialogHelper } = ChromeUtils.import(
  "resource://testing-common/mozmill/CustomizationHelpers.jsm"
);
var { close_popup, mc, wait_for_popup_to_open } = ChromeUtils.import(
  "resource://testing-common/mozmill/FolderDisplayHelpers.jsm"
);
var { drag_n_drop_element } = ChromeUtils.import(
  "resource://testing-common/mozmill/MouseEventHelpers.jsm"
);

var gCDHelper;

add_setup(function () {
  gCDHelper = new CustomizeDialogHelper(
    "toolbar-menubar",
    "CustomizeMailToolbar",
    "mailnews:customizeToolbar"
  );
  Services.prefs.setBoolPref("mail.tabs.autoHide", false);
});

registerCleanupFunction(async function () {
  // Let's reset any and all of our changes to the toolbar
  await gCDHelper.restoreDefaultButtons(mc);
  Services.prefs.clearUserPref("mail.tabs.autoHide");
});

/**
 * Test that we can access the customize context menu by right
 * clicking on the tabs toolbar.
 */
add_task(async function test_open_context_menu() {
  // First, ensure that the context menu is closed.
  let contextPopup = mc.window.document.getElementById("toolbar-context-menu");
  Assert.notEqual(contextPopup.state, "open");

  // Right click on the tab bar
  EventUtils.synthesizeMouseAtCenter(
    mc.window.document.getElementById("tabmail-tabs"),
    { type: "contextmenu" },
    window
  );

  // Ensure that the popup opened
  await wait_for_popup_to_open(contextPopup);

  await close_popup(mc, contextPopup);
});

/**
 * Test that, when customizing the toolbars, if the user drags an item onto
 * the tab bar, they're redirected to the toolbar directly to the right of
 * the tab bar.
 */
add_task(async function test_redirects_toolbarbutton_drops() {
  Services.prefs.setBoolPref("toolkit.customization.unsafe_drag_events", true);
  // Restore the default buttons to get defined starting conditions.
  await gCDHelper.restoreDefaultButtons(mc);

  let tabbar = mc.window.document.getElementById("tabmail-tabs");
  let toolbar = mc.window.document.getElementById("tabbar-toolbar");

  // First, let's open up the customize toolbar window.
  let ctw = await gCDHelper.open(mc);

  // Let's grab some items from the customize window, and try dropping
  // them on the tab bar
  [
    "wrapper-button-previous",
    "wrapper-button-previousMsg",
    "wrapper-button-nextMsg",
    "wrapper-button-next",
  ].forEach(function (aButtonId) {
    let button = ctw.window.document.getElementById(aButtonId);

    drag_n_drop_element(
      button,
      ctw.window,
      tabbar,
      mc.window,
      0.5,
      0.5,
      ctw.window
    );

    // Now let's check to make sure that this button is now the first
    // item in the tab bar toolbar.
    Assert.equal(
      toolbar.firstElementChild.id,
      aButtonId,
      "Button was not added as first child!"
    );
  });

  gCDHelper.close(ctw);
  Services.prefs.clearUserPref("toolkit.customization.unsafe_drag_events");
});
