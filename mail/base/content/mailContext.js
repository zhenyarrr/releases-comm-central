/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

// mailCommon.js
/* globals commandController */

// about:3pane and about:message must BOTH provide these:

/* globals goDoCommand */ // globalOverlay.js
/* globals gDBView, gFolder, gViewWrapper, messengerBundle */

var { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm"
);
var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  MailUtils: "resource:///modules/MailUtils.jsm",
  PhishingDetector: "resource:///modules/PhishingDetector.jsm",
  TagUtils: "resource:///modules/TagUtils.jsm",
});

window.addEventListener("DOMContentLoaded", event => {
  if (
    event.target != document ||
    window.browsingContext.parent != window.browsingContext.top
  ) {
    return;
  }

  mailContextMenu.init();
});

/**
 * Called by ContextMenuParent if this window is about:3pane, or is
 * about:message but not contained by about:3pane.
 *
 * @returns {boolean} true if this function opened the context menu
 */
function openContextMenu({ data, target }) {
  if (window.browsingContext.parent != window.browsingContext.top) {
    // Not sure how we'd get here, but let's not continue if we do.
    return false;
  }

  // TODO we'll want the context menu in non-mail pages, when they work.
  const MESSAGE_PROTOCOLS = ["imap", "mailbox", "news", "nntp", "snews"];
  if (!MESSAGE_PROTOCOLS.includes(target.browsingContext.currentURI.scheme)) {
    return false;
  }

  mailContextMenu.fillMessageContextMenu(data, target.browsingContext);
  let screenX = data.context.screenXDevPx / window.devicePixelRatio;
  let screenY = data.context.screenYDevPx / window.devicePixelRatio;
  let popup = document.getElementById("mailContext");
  popup.openPopupAtScreen(screenX, screenY, true);

  return true;
}

var mailContextMenu = {
  // Commands handled by commandController.
  _commandMap: {
    "mailContext-editDraftMsg": "cmd_editDraftMsg",
    "mailContext-newMsgFromTemplate": "cmd_newMsgFromTemplate",
    "mailContext-editTemplateMsg": "cmd_editTemplateMsg",
    "mailContext-openConversation": "cmd_openConversation",
    "mailContext-replyNewsgroup": "cmd_replyGroup",
    "mailContext-replySender": "cmd_replySender",
    "mailContext-replyAll": "cmd_replyall",
    "mailContext-replyList": "cmd_replylist",
    "mailContext-forward": "cmd_forward",
    "mailContext-forwardAsInline": "cmd_forwardInline",
    "mailContext-forwardAsAttachment": "cmd_forwardAttachment",
    "mailContext-multiForwardAsAttachment": "cmd_forwardAttachment",
    "mailContext-redirect": "cmd_redirect",
    "mailContext-editAsNew": "cmd_editAsNew",
    "mailContext-addNewTag": "cmd_addTag",
    "mailContext-manageTags": "cmd_manageTags",
    "mailContext-tagRemoveAll": "cmd_removeTags",
    "mailContext-markReadByDate": "cmd_markReadByDate",
    "mailContext-markFlagged": "cmd_markAsFlagged",
    "mailContext-archive": "cmd_archive",
    "mailcontext-moveToFolderAgain": "cmd_moveToFolderAgain",
    "mailContext-delete": "cmd_delete",
    "mailContext-ignoreThread": "cmd_killThread",
    "mailContext-ignoreSubthread": "cmd_killSubthread",
    "mailContext-watchThread": "cmd_watchThread",
    "mailContext-saveAs": "cmd_saveAsFile",
    "mailContext-print": "cmd_print",
    "mailContext-downloadSelected": "cmd_downloadSelected",
  },

  // More commands handled by commandController, except these ones get
  // disabled instead of hidden.
  _alwaysVisibleCommandMap: {
    "mailContext-markRead": "cmd_markAsRead",
    "mailContext-markUnread": "cmd_markAsUnread",
    "mailContext-markThreadAsRead": "cmd_markThreadAsRead",
    "mailContext-markAllRead": "cmd_markAllRead",
    "mailContext-markAsJunk": "cmd_markAsJunk",
    "mailContext-markAsNotJunk": "cmd_markAsNotJunk",
    "mailContext-recalculateJunkScore": "cmd_recalculateJunkScore",
  },

  init() {
    let mailContext = document.getElementById("mailContext");
    mailContext.addEventListener("popupshowing", event => {
      if (event.target == mailContext) {
        this.fillMailContextMenu(event);
      }
    });
    mailContext.addEventListener("command", event =>
      this.onMailContextMenuCommand(event)
    );
  },

  emptyMessageContextMenu() {
    delete this.browsingContext;
    delete this.context;
    delete this.selectionInfo;

    for (let id of [
      "mailContext-openInBrowser",
      "mailContext-openLinkInBrowser",
      "mailContext-copylink",
      "mailContext-savelink",
      "mailContext-reportPhishingURL",
      "mailContext-addemail",
      "mailContext-composeemailto",
      "mailContext-copyemail",
      "mailContext-copyimage",
      "mailContext-saveimage",
      "mailContext-copy",
      "mailContext-selectall",
      "mailContext-searchTheWeb",
    ]) {
      document.getElementById(id).hidden = true;
    }
  },

  fillMessageContextMenu({ context, selectionInfo }, browsingContext) {
    function showItem(id, show) {
      let item = document.getElementById(id);
      if (item) {
        item.hidden = !show;
      }
    }

    this.browsingContext = browsingContext;
    this.context = context;
    this.selectionInfo = selectionInfo;

    // showItem("mailContext-openInBrowser", false);
    showItem(
      "mailContext-openLinkInBrowser",
      context.onLink && !context.onMailtoLink
    );
    showItem("mailContext-copylink", context.onLink && !context.onMailtoLink);
    // showItem("mailContext-savelink", false);
    showItem(
      "mailContext-reportPhishingURL",
      context.onLink && !context.onMailtoLink
    );
    showItem("mailContext-addemail", context.onMailtoLink);
    showItem("mailContext-composeemailto", context.onMailtoLink);
    showItem("mailContext-copyemail", context.onMailtoLink);
    showItem("mailContext-copyimage", context.onImage);
    showItem("mailContext-saveimage", context.onLoadedImage);
    showItem(
      "mailContext-copy",
      selectionInfo && !selectionInfo.docSelectionIsCollapsed
    );
    showItem("mailContext-selectall", true);
    showItem(
      "mailContext-searchTheWeb",
      selectionInfo && !selectionInfo.docSelectionIsCollapsed
    );

    let searchTheWeb = document.getElementById("mailContext-searchTheWeb");
    if (!searchTheWeb.hidden) {
      let key = "openSearch.label";
      let abbrSelection;
      if (selectionInfo.text.length > 15) {
        key += ".truncated";
        abbrSelection = selectionInfo.text.slice(0, 15);
      } else {
        abbrSelection = selectionInfo.text;
      }

      searchTheWeb.label = messengerBundle.formatStringFromName(key, [
        Services.search.defaultEngine.name,
        abbrSelection,
      ]);
    }
  },

  fillMailContextMenu(event) {
    function showItem(id, show) {
      let item = document.getElementById(id);
      if (item) {
        item.hidden = !show;
      }
    }

    function enableItem(id, enabled) {
      let item = document.getElementById(id);
      item.disabled = !enabled;
    }

    function checkItem(id, checked) {
      let item = document.getElementById(id);
      if (item) {
        // Convert truthy/falsy to boolean before string.
        item.setAttribute("checked", !!checked);
      }
    }

    function setSingleSelection(id, show = true) {
      showItem(id, numSelectedMessages == 1 && show);
      enableItem(id, numSelectedMessages == 1);
    }

    // Hide things that don't work yet.
    for (let id of [
      "mailContext-openInBrowser",
      "mailContext-savelink",
      "mailContext-recalculateJunkScore",
      "mailContext-copyMessageUrl",
      "mailContext-calendar-convert-menu",
    ]) {
      showItem(id, false);
    }

    // Ask commandController about the commands it controls.
    for (let [id, command] of Object.entries(this._commandMap)) {
      showItem(id, commandController.isCommandEnabled(command));
    }
    for (let [id, command] of Object.entries(this._alwaysVisibleCommandMap)) {
      enableItem(id, commandController.isCommandEnabled(command));
    }

    let inAbout3Pane = !!window.threadTree;
    let inThreadTree = window.threadTree?.contains(
      event.explicitOriginalTarget
    );
    let isDummyMessage = !gFolder;
    let message = isDummyMessage
      ? window.messageHeaderSink.dummyMsgHeader
      : gDBView.hdrForFirstSelectedMessage;
    let folder = gViewWrapper.displayedFolder;
    let numSelectedMessages = isDummyMessage ? 1 : gDBView.numSelected;
    let isNewsgroup = gFolder?.isSpecialFolder(
      Ci.nsMsgFolderFlags.Newsgroup,
      true
    );
    let canMove =
      numSelectedMessages >= 1 && !isNewsgroup && gFolder?.canDeleteMessages;
    let canCopy = numSelectedMessages >= 1;

    setSingleSelection("mailContext-openNewTab", inThreadTree);
    setSingleSelection("mailContext-openNewWindow", inThreadTree);
    setSingleSelection("mailContext-openContainingFolder", !inAbout3Pane);
    setSingleSelection("mailContext-forwardAsMenu");
    showItem(
      "mailContext-multiForwardAsAttachment",
      numSelectedMessages > 1 &&
        commandController.isCommandEnabled("cmd_forwardAttachment")
    );

    if (isDummyMessage) {
      enableItem("mailContext-tags", false);
    } else {
      enableItem("mailContext-tags", true);
      this._initMessageTags();
    }
    checkItem("mailContext-markFlagged", message?.isFlagged);

    setSingleSelection("mailContext-copyMessageUrl", isNewsgroup);
    // Disable move if we can't delete message(s) from this folder.
    showItem("mailContext-moveMenu", canMove);
    showItem("mailContext-copyMenu", canCopy);

    window.browsingContext.topChromeWindow.initMoveToFolderAgainMenu(
      document.getElementById("mailContext-moveToFolderAgain")
    );

    // setSingleSelection("mailContext-calendar-convert-menu");
    document.l10n.setAttributes(
      document.getElementById("mailContext-delete"),
      "mail-context-delete-messages",
      {
        count: numSelectedMessages,
      }
    );

    checkItem(
      "mailContext-ignoreThread",
      folder?.msgDatabase.isIgnored(message?.messageKey)
    );
    checkItem(
      "mailContext-ignoreSubthread",
      folder && message.flags & Ci.nsMsgMessageFlags.Ignored
    );
    checkItem(
      "mailContext-watchThread",
      folder?.msgDatabase.isWatched(message?.messageKey)
    );

    showItem(
      "mailContext-downloadSelected",
      window.threadTree && numSelectedMessages > 1
    );

    let lastItem;
    for (let child of document.getElementById("mailContext").children) {
      if (child.localName == "menuseparator") {
        child.hidden = !lastItem || lastItem.localName == "menuseparator";
      }
      if (!child.hidden) {
        lastItem = child;
      }
    }
    if (lastItem.localName == "menuseparator") {
      lastItem.hidden = true;
    }
  },

  onMailContextMenuCommand(event) {
    // If commandController handles this command, ask it to do so.
    if (event.target.id in this._commandMap) {
      commandController.doCommand(this._commandMap[event.target.id], event);
      return;
    }
    if (event.target.id in this._alwaysVisibleCommandMap) {
      commandController.doCommand(
        this._alwaysVisibleCommandMap[event.target.id],
        event
      );
      return;
    }

    let topChromeWindow = window.browsingContext.topChromeWindow;
    switch (event.target.id) {
      // Links
      // case "mailContext-openInBrowser":
      //   this._openInBrowser();
      //   break;
      case "mailContext-openLinkInBrowser":
        // Only called in about:message.
        // eslint-disable-next-line no-undef
        openLinkExternally(this.context.linkURL);
        break;
      case "mailContext-copylink":
        goDoCommand("cmd_copyLink");
        break;
      // case "mailContext-savelink":
      //   topChromeWindow.saveURL(
      //     this.context.linkURL,
      //     this.context.linkTextStr,
      //     null,
      //     true,
      //     null,
      //     null,
      //     null,
      //     this.browsingContext.window.document
      //   );
      //   break;
      case "mailContext-reportPhishingURL":
        PhishingDetector.reportPhishingURL(this.context.linkURL);
        break;
      case "mailContext-addemail":
        topChromeWindow.addEmail(this.context.linkURL);
        break;
      case "mailContext-composeemailto":
        topChromeWindow.composeEmailTo(
          this.context.linkURL,
          MailServices.accounts.getFirstIdentityForServer(gFolder.server)
        );
        break;
      case "mailContext-copyemail": {
        let addresses = topChromeWindow.getEmail(this.context.linkURL);
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(addresses);
        break;
      }

      // Images
      case "mailContext-copyimage":
        goDoCommand("cmd_copyImage");
        break;
      case "mailContext-saveimage":
        topChromeWindow.saveURL(
          this.context.imageInfo.currentSrc,
          null,
          null,
          "SaveImageTitle",
          false,
          null,
          null,
          null,
          this.browsingContext.window.document
        );
        break;

      // Edit
      case "mailContext-copy":
        goDoCommand("cmd_copy");
        break;
      case "mailContext-selectall":
        goDoCommand("cmd_selectAll");
        break;

      // Search
      case "mailContext-searchTheWeb":
        topChromeWindow.openWebSearch(this.selectionInfo.text);
        break;

      // Open messages
      case "mailContext-openNewTab":
        topChromeWindow.OpenMessageInNewTab(
          gDBView.hdrForFirstSelectedMessage,
          {
            event,
            viewWrapper: gViewWrapper,
          }
        );
        break;
      case "mailContext-openNewWindow":
        topChromeWindow.MsgOpenNewWindowForMessage(
          gDBView.hdrForFirstSelectedMessage,
          gViewWrapper
        );
        break;
      case "mailContext-openContainingFolder":
        MailUtils.displayMessageInFolderTab(gDBView.hdrForFirstSelectedMessage);
        break;

      // Move/copy/archive/convert/delete
      // (Move and Copy sub-menus are handled in the default case.)
      case "mailContext-copyMessageUrl": {
        let message = gDBView.hdrForFirstSelectedMessage;
        let server = message?.folder?.server;

        if (!server) {
          return;
        }

        // TODO let backend construct URL and return as attribute
        let url =
          server.socketType == Ci.nsMsgSocketType.SSL ? "snews://" : "news://";
        url += server.hostName + ":" + server.port + "/" + message.messageId;

        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(url);
        break;
      }

      // Calendar Convert sub-menu
      // case "mailContext-calendar-convert-event-menuitem":
      //   calendarExtract.extractFromEmail(true);
      //   break;
      // case "mailContext-calendar-convert-task-menuitem":
      //   calendarExtract.extractFromEmail(false);
      //   break;

      // Save/print/download
      default: {
        if (
          document.getElementById("mailContext-moveMenu").contains(event.target)
        ) {
          commandController.doCommand("cmd_moveMessage", event.target._folder);
        } else if (
          document.getElementById("mailContext-copyMenu").contains(event.target)
        ) {
          commandController.doCommand("cmd_copyMessage", event.target._folder);
        }
        break;
      }
    }
  },

  // Tags sub-menu

  /**
   * Refresh the contents of the tag popup menu/panel.
   * Used for example for appmenu/Message/Tag panel.
   *
   * @param {Element} parent - Parent element that will contain the menu items.
   * @param {string} [elementName] - Type of menu item, e.g. "menuitem", "toolbarbutton".
   * @param {string} [classes] - Classes to set on the menu items.
   */
  _initMessageTags() {
    let parent = document.getElementById("mailContext-tagpopup");
    // Remove any existing non-static items (clear tags list before rebuilding it).
    // There is a separator element above the dynamically added tag elements, so
    // remove dynamically added elements below the separator.
    while (parent.lastElementChild.localName == "menuitem") {
      parent.lastElementChild.remove();
    }

    // Create label and accesskey for the static "remove all tags" item.
    let removeItem = document.getElementById("mailContext-tagRemoveAll");
    removeItem.label = messengerBundle.GetStringFromName(
      "mailnews.tags.remove"
    );

    // Rebuild the list.
    let message = gDBView.hdrForFirstSelectedMessage;
    let currentTags = message
      ? message.getStringProperty("keywords").split(" ")
      : [];
    let index = 1;

    for (let tagInfo of MailServices.tags.getAllTags()) {
      let msgHasTag = currentTags.includes(tagInfo.key);
      if (tagInfo.ordinal.includes("~AUTOTAG") && !msgHasTag) {
        return;
      }

      let item = document.createXULElement("menuitem");
      item.accessKey = index < 10 ? index : "";
      item.label = messengerBundle.formatStringFromName(
        "mailnews.tags.format",
        [item.accessKey, tagInfo.tag]
      );
      item.setAttribute("type", "checkbox");
      if (msgHasTag) {
        item.setAttribute("checked", "true");
      }
      item.value = tagInfo.key;
      item.addEventListener("command", event =>
        this._toggleMessageTag(
          tagInfo.key,
          item.getAttribute("checked") == "true"
        )
      );
      if (tagInfo.color) {
        item.style.color = tagInfo.color;
      }
      parent.appendChild(item);

      index++;
    }
  },

  removeAllMessageTags() {
    let selectedMessages = gDBView.getSelectedMsgHdrs();
    if (!selectedMessages.length) {
      return;
    }

    let messages = [];
    let allKeys = MailServices.tags
      .getAllTags()
      .map(t => t.key)
      .join(" ");
    let prevHdrFolder = null;

    // This crudely handles cross-folder virtual folders with selected
    // messages that spans folders, by coalescing consecutive messages in the
    // selection that happen to be in the same folder. nsMsgSearchDBView does
    // this better, but nsIMsgDBView doesn't handle commands with arguments,
    // and untag takes a key argument. Furthermore, we only delete known tags,
    // keeping other keywords like (non)junk intact.
    for (let i = 0; i < selectedMessages.length; ++i) {
      let msgHdr = selectedMessages[i];
      if (prevHdrFolder != msgHdr.folder) {
        if (prevHdrFolder) {
          prevHdrFolder.removeKeywordsFromMessages(messages, allKeys);
        }
        messages = [];
        prevHdrFolder = msgHdr.folder;
      }
      messages.push(msgHdr);
    }
    if (prevHdrFolder) {
      prevHdrFolder.removeKeywordsFromMessages(messages, allKeys);
    }
  },

  _toggleMessageTag(key, addKey) {
    let messages = [];
    let selectedMessages = gDBView.getSelectedMsgHdrs();
    let toggler = addKey
      ? "addKeywordsToMessages"
      : "removeKeywordsFromMessages";
    let prevHdrFolder = null;
    // this crudely handles cross-folder virtual folders with selected messages
    // that spans folders, by coalescing consecutive msgs in the selection
    // that happen to be in the same folder. nsMsgSearchDBView does this
    // better, but nsIMsgDBView doesn't handle commands with arguments,
    // and (un)tag takes a key argument.
    for (let i = 0; i < selectedMessages.length; ++i) {
      let msgHdr = selectedMessages[i];
      if (msgHdr.label) {
        // Since we touch all these messages anyway, migrate the label now.
        // If we don't, the thread tree won't always show the correct tag state,
        // because resetting a label doesn't update the tree anymore...
        msgHdr.folder.addKeywordsToMessages([msgHdr], "$label" + msgHdr.label);
        msgHdr.label = 0; // remove legacy label
      }
      if (prevHdrFolder != msgHdr.folder) {
        if (prevHdrFolder) {
          prevHdrFolder[toggler](messages, key);
        }
        messages = [];
        prevHdrFolder = msgHdr.folder;
      }
      messages.push(msgHdr);
    }
    if (prevHdrFolder) {
      prevHdrFolder[toggler](messages, key);
    }
  },

  /**
   * Toggle the state of a message tag on the selected messages (based on the
   * state of the first selected message, like for starring).
   *
   * @param {number} keyNumber - The number (1 through 9) associated with the tag.
   */
  _toggleMessageTagKey(keyNumber) {
    let msgHdr = gDBView.hdrForFirstSelectedMessage;
    if (!msgHdr) {
      return;
    }

    let tagArray = MailServices.tags.getAllTags();
    if (keyNumber > tagArray.length) {
      return;
    }

    let key = tagArray[keyNumber - 1].key;
    let curKeys = msgHdr.getStringProperty("keywords").split(" ");
    if (msgHdr.label) {
      curKeys.push("$label" + msgHdr.label);
    }
    let addKey = !curKeys.includes(key);

    this._toggleMessageTag(key, addKey);
  },

  addTag() {
    window.browsingContext.topChromeWindow.openDialog(
      "chrome://messenger/content/newTagDialog.xhtml",
      "",
      "chrome,titlebar,modal,centerscreen",
      {
        result: "",
        okCallback(name, color) {
          MailServices.tags.addTag(name, color, "");
          let key = MailServices.tags.getKeyForTag(name);
          TagUtils.addTagToAllDocumentSheets(key, color);

          try {
            this._toggleMessageTag(key, true);
          } catch (ex) {
            return false;
          }
          return true;
        },
      }
    );
  },
};
