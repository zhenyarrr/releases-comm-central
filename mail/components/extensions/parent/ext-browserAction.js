/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  storeState: "resource:///modules/CustomizationState.mjs",
  getState: "resource:///modules/CustomizationState.mjs",
  registerExtension: "resource:///modules/CustomizableItems.sys.mjs",
  unregisterExtension: "resource:///modules/CustomizableItems.sys.mjs",
});
var { ExtensionCommon } = ChromeUtils.import(
  "resource://gre/modules/ExtensionCommon.jsm"
);
var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  ToolbarButtonAPI: "resource:///modules/ExtensionToolbarButtons.jsm",
  getCachedAllowedSpaces: "resource:///modules/ExtensionToolbarButtons.jsm",
  setCachedAllowedSpaces: "resource:///modules/ExtensionToolbarButtons.jsm",
});

var { makeWidgetId } = ExtensionCommon;

const browserActionMap = new WeakMap();

this.browserAction = class extends ToolbarButtonAPI {
  static for(extension) {
    return browserActionMap.get(extension);
  }

  async onManifestEntry(entryName) {
    await super.onManifestEntry(entryName);
    browserActionMap.set(this.extension, this);

    if (this.inUnifiedToolbar) {
      await registerExtension(this.extension.id, this.allowedSpaces);
      const currentToolbarState = getState();
      const unifiedToolbarButtonId = `ext-${this.extension.id}`;

      // Load the cached allowed spaces. Make sure there are no awaited promises
      // before storing the updated allowed spaces, as it could have been changed
      // elsewhere.
      let cachedAllowedSpaces = getCachedAllowedSpaces();
      let priorAllowedSpaces = cachedAllowedSpaces.get(this.extension.id);

      // If the extension has set allowedSpaces to an empty array, the button needs
      // to be added to all available spaces.
      let allowedSpaces =
        this.allowedSpaces.length == 0
          ? [
              "mail",
              "addressbook",
              "calendar",
              "tasks",
              "chat",
              "settings",
              "default",
            ]
          : this.allowedSpaces;

      // Manually add the button to all customized spaces, where it has not been
      // allowed in the prior version of this add-on (if any). This automatically
      // covers the install and the update case, including staged updates.
      // Spaces which have not been customized will receive the button from
      // getDefaultItemIdsForSpace() in CustomizableItems.sys.mjs.
      let missingSpacesInState = allowedSpaces.filter(
        space =>
          (!priorAllowedSpaces || !priorAllowedSpaces.includes(space)) &&
          space !== "default" &&
          currentToolbarState.hasOwnProperty(space) &&
          !currentToolbarState[space].includes(unifiedToolbarButtonId)
      );
      for (const space of missingSpacesInState) {
        currentToolbarState[space].push(unifiedToolbarButtonId);
      }

      // Manually remove button from all customized spaces, if it is no longer
      // allowed. This will remove its stored customized positioning information.
      // If a space becomes allowed again later, the button will be added to the
      // end of the space and not at its former customized location.
      let invalidSpacesInState = [];
      if (priorAllowedSpaces) {
        invalidSpacesInState = priorAllowedSpaces.filter(
          space =>
            space !== "default" &&
            !allowedSpaces.includes(space) &&
            currentToolbarState.hasOwnProperty(space) &&
            currentToolbarState[space].includes(unifiedToolbarButtonId)
        );
        for (const space of invalidSpacesInState) {
          currentToolbarState[space] = currentToolbarState[space].filter(
            id => id != unifiedToolbarButtonId
          );
        }
      }

      // Update the cached values for the allowed spaces.
      cachedAllowedSpaces.set(this.extension.id, allowedSpaces);
      setCachedAllowedSpaces(cachedAllowedSpaces);

      if (missingSpacesInState.length || invalidSpacesInState.length) {
        storeState(currentToolbarState);
      } else {
        Services.obs.notifyObservers(null, "unified-toolbar-state-change");
      }
    }
  }

  close() {
    super.close();
    browserActionMap.delete(this.extension);
    windowTracker.removeListener("TabSelect", this);
    if (this.inUnifiedToolbar) {
      unregisterExtension(this.extension.id);
      Services.obs.notifyObservers(null, "unified-toolbar-state-change");
    }
  }

  constructor(extension) {
    super(extension, global);
    this.manifest_name =
      extension.manifestVersion < 3 ? "browser_action" : "action";
    this.manifestName =
      extension.manifestVersion < 3 ? "browserAction" : "action";
    let manifest = extension.manifest[this.manifest_name];

    this.windowURLs = [];
    if (manifest.default_windows.includes("normal")) {
      this.inUnifiedToolbar = true;
    }
    if (manifest.default_windows.includes("messageDisplay")) {
      this.windowURLs.push("chrome://messenger/content/messageWindow.xhtml");
    }

    this.toolboxId = "mail-toolbox";
    this.toolbarId = "mail-bar3";

    this.allowedSpaces = this.extension.manifest[
      this.manifest_name
    ].allowed_spaces;

    windowTracker.addListener("TabSelect", this);
  }

  static onUpdate(extensionId, manifest) {
    // These manifest entries can exist and be null.
    if (!manifest.browser_action && !manifest.action) {
      this.#removeFromUnifiedToolbar(extensionId);
    }
  }

  static onUninstall(extensionId) {
    let widgetId = makeWidgetId(extensionId);
    let id = `${widgetId}-browserAction-toolbarbutton`;

    // Check all possible XUL toolbars and remove the toolbarbutton if found.
    // Sadly we have to hardcode these values here, as the add-on is already
    // shutdown when onUninstall is called.
    let toolbars = ["mail-bar3", "toolbar-menubar"];
    for (let toolbar of toolbars) {
      for (let setName of ["currentset", "extensionset"]) {
        let set = Services.xulStore
          .getValue(
            "chrome://messenger/content/messageWindow.xhtml",
            toolbar,
            setName
          )
          .split(",");
        let newSet = set.filter(e => e != id);
        if (newSet.length < set.length) {
          Services.xulStore.setValue(
            "chrome://messenger/content/messageWindow.xhtml",
            toolbar,
            setName,
            newSet.join(",")
          );
        }
      }
    }

    this.#removeFromUnifiedToolbar(extensionId);
  }

  static #removeFromUnifiedToolbar(extensionId) {
    const currentToolbarState = getState();
    const unifiedToolbarButtonId = `ext-${extensionId}`;
    let modifiedState = false;
    for (const space of Object.keys(currentToolbarState)) {
      if (currentToolbarState[space].includes(unifiedToolbarButtonId)) {
        currentToolbarState[space].splice(
          currentToolbarState[space].indexOf(unifiedToolbarButtonId),
          1
        );
        modifiedState = true;
      }
    }
    if (modifiedState) {
      storeState(currentToolbarState);
    }

    // Update cachedAllowedSpaces for the unified toolbar.
    let cachedAllowedSpaces = getCachedAllowedSpaces();
    if (cachedAllowedSpaces.has(extensionId)) {
      cachedAllowedSpaces.delete(extensionId);
      setCachedAllowedSpaces(cachedAllowedSpaces);
    }
  }

  handleEvent(event) {
    super.handleEvent(event);
    let window = event.target.ownerGlobal;

    switch (event.type) {
      case "popupshowing":
        const menu = event.target;
        const trigger = menu.triggerNode;
        const node =
          window.document.getElementById(this.id) ||
          (this.inUnifiedToolbar &&
            window.document.querySelector(
              `#unifiedToolbarContent [item-id="ext-${this.extension.id}"]`
            ));
        const contexts = [
          "toolbar-context-menu",
          "customizationPanelItemContextMenu",
          "unifiedToolbarMenu",
        ];

        if (contexts.includes(menu.id) && node && node.contains(trigger)) {
          // This needs to work in normal window and message window.
          let tab = tabTracker.activeTab;
          let browser = tab.linkedBrowser || tab.getBrowser?.();
          const action =
            this.extension.manifestVersion < 3 ? "onBrowserAction" : "onAction";

          global.actionContextMenu({
            tab,
            pageUrl: browser?.currentURI?.spec,
            extension: this.extension,
            [action]: true,
            menu,
          });
        }
        break;
    }
  }
};

global.browserActionFor = this.browserAction.for;
