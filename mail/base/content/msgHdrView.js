/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Functions related to displaying the headers for a selected message in the
 * message pane.
 */

/* import-globals-from ../../../calendar/base/content/imip-bar.js */
/* import-globals-from ../../extensions/smime/content/msgHdrViewSMIMEOverlay.js */
/* import-globals-from aboutMessage.js */
/* import-globals-from editContactPanel.js */
/* import-globals-from mailContext.js */
/* import-globals-from mail-offline.js */
/* import-globals-from mailCore.js */
/* import-globals-from msgSecurityPane.js */

/* globals MozElements */

var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  Downloads: "resource://gre/modules/Downloads.jsm",
  FileUtils: "resource://gre/modules/FileUtils.jsm",
  Gloda: "resource:///modules/gloda/GlodaPublic.jsm",
  GlodaUtils: "resource:///modules/gloda/GlodaUtils.jsm",
  MailUtils: "resource:///modules/MailUtils.jsm",
  MessageArchiver: "resource:///modules/MessageArchiver.jsm",
  PgpSqliteDb2: "chrome://openpgp/content/modules/sqliteDb.jsm",
  PluralForm: "resource://gre/modules/PluralForm.jsm",
});

XPCOMUtils.defineLazyServiceGetter(
  this,
  "gDbService",
  "@mozilla.org/msgDatabase/msgDBService;1",
  "nsIMsgDBService"
);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "gMIMEService",
  "@mozilla.org/mime;1",
  "nsIMIMEService"
);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "gHandlerService",
  "@mozilla.org/uriloader/handler-service;1",
  "nsIHandlerService"
);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "gEncryptedSMIMEURIsService",
  "@mozilla.org/messenger-smime/smime-encrypted-uris-service;1",
  Ci.nsIEncryptedSMIMEURIsService
);

// Warning: It's critical that the code in here for displaying the message
// headers for a selected message remain as fast as possible. In particular,
// right now, we only introduce one reflow per message. i.e. if you click on
// a message in the thread pane, we batch up all the changes for displaying
// the header pane (to, cc, attachments button, etc.) and we make a single
// pass to display them. It's critical that we maintain this one reflow per
// message view in the message header pane.

var gViewAllHeaders = false;
var gMinNumberOfHeaders = 0;
var gDummyHeaderIdIndex = 0;
var gBuildAttachmentsForCurrentMsg = false;
var gBuiltExpandedView = false;
var gHeadersShowReferences = false;

/**
 * Show the friendly display names for people I know,
 * instead of the name + email address.
 */
var gShowCondensedEmailAddresses;

/**
 * Other components may listen to on start header & on end header notifications
 * for each message we display: to do that you need to add yourself to our
 * gMessageListeners array with an object that supports the three properties:
 * onStartHeaders, onEndHeaders and onEndAttachments.
 *
 * Additionally, if your object has an onBeforeShowHeaderPane() method, it will
 * be called at the appropriate time.  This is designed to give add-ons a
 * chance to examine and modify the currentHeaderData array before it gets
 * displayed.
 */
var gMessageListeners = [];

/**
 * List fo common headers that need to be populated.
 *
 * For every possible "view" in the message pane, you need to define the header
 * names you want to see in that view. In addition, include information
 * describing how you want that header field to be presented. We'll then use
 * this static table to dynamically generate header view entries which
 * manipulate the UI.
 *
 * @param {string} name - The name of the header. i.e. "to", "subject". This
 *   must be in lower case and the name of the header is used to help
 *   dynamically generate ids for objects in the document.
 * @param {Function} outputFunction - This is a method which takes a headerEntry
 *   (see the definition below) and a header value. This allows to provide a
 *   unique methods for determining how the header value is displayed. Defaults
 *   to updateHeaderValue which just sets the header value on the text node.
 */
const gExpandedHeaderList = [
  { name: "subject" },
  { name: "from", outputFunction: outputEmailAddresses },
  { name: "reply-to", outputFunction: outputEmailAddresses },
  { name: "to", outputFunction: outputEmailAddresses },
  { name: "cc", outputFunction: outputEmailAddresses },
  { name: "bcc", outputFunction: outputEmailAddresses },
  { name: "newsgroups", outputFunction: outputNewsgroups },
  { name: "references", outputFunction: outputMessageIds },
  { name: "followup-to", outputFunction: outputNewsgroups },
  { name: "content-base" },
  { name: "tags", outputFunction: outputTags },
];

/**
 * These are all the items that use a multi-recipient-row widget and
 * therefore may require updating if the address book changes.
 */
var gEmailAddressHeaderNames = [
  "from",
  "reply-to",
  "to",
  "cc",
  "bcc",
  "toCcBcc",
];

/**
 * Now, for each view the message pane can generate, we need a global table of
 * headerEntries. These header entry objects are generated dynamically based on
 * the static data in the header lists (see above) and elements we find in the
 * DOM based on properties in the header lists.
 */
var gExpandedHeaderView = {};

/**
 * This is an array of header name and value pairs for the currently displayed
 * message. It's purely a data object and has no view information. View
 * information is contained in the view objects.
 * For a given entry in this array you can ask for:
 * .headerName   name of the header (i.e. 'to'). Always stored in lower case
 * .headerValue  value of the header "johndoe@example.com"
 */
var currentHeaderData = {};

/**
 * CurrentAttachments is an array of AttachmentInfo objects.
 */
var currentAttachments = [];

/**
 * The character set of the message, according to the MIME parser.
 */
var currentCharacterSet = "";

/**
 * Folder database listener object. This is used alongside the
 * nsIDBChangeListener implementation in order to listen for the changes of the
 * messages' flags that don't trigger a messageHeaderSink.processHeaders().
 * For now, it's used only for the flagged/marked/starred flag, but it could be
 * extended to handle other flags changes and remove the full header reload.
 */
var gFolderDBListener = null;

// Timer to mark read, if the user has configured the app to mark a message as
// read if it is viewed for more than n seconds.
var gMarkViewedMessageAsReadTimer = null;

// Per message header flags to keep track of whether the user is allowing remote
// content for a particular message.
// if you change or add more values to these constants, be sure to modify
// the corresponding definitions in nsMsgContentPolicy.cpp
var kNoRemoteContentPolicy = 0;
var kBlockRemoteContent = 1;
var kAllowRemoteContent = 2;

class FolderDBListener {
  constructor(folder) {
    // Keep a record of the currently selected folder to check when the
    // selection changes to avoid initializing the DBListener in case the same
    // folder is selected.
    this.selectedFolder = folder;
    this.isRegistered = false;
  }

  register() {
    gDbService.registerPendingListener(this.selectedFolder, this);
    this.isRegistered = true;
  }

  unregister() {
    gDbService.unregisterPendingListener(this);
    this.isRegistered = false;
  }

  /** @implements {nsIDBChangeListener} */
  onHdrFlagsChanged(hdrChanged, oldFlags, newFlags, instigator) {
    // Bail out if the changed message isn't the one currently displayed.
    if (hdrChanged != gMessage) {
      return;
    }

    // Check if the flagged/marked/starred state was changed.
    if (
      newFlags & Ci.nsMsgMessageFlags.Marked ||
      oldFlags & Ci.nsMsgMessageFlags.Marked
    ) {
      updateStarButton();
    }
  }
  onHdrDeleted(hdrChanged, parentKey, flags, instigator) {}
  onHdrAdded(hdrChanged, parentKey, flags, instigator) {}
  onParentChanged(keyChanged, oldParent, newParent, instigator) {}
  onAnnouncerGoingAway(instigator) {}
  onReadChanged(instigator) {}
  onJunkScoreChanged(instigator) {}
  onHdrPropertyChanged(hdrToChange, property, preChange, status, instigator) {
    // Not interested before a change, or if the message isn't the one displayed,
    // or an .eml file from disk or an attachment.
    if (preChange || gMessage != hdrToChange) {
      return;
    }
    switch (property) {
      case "keywords":
        OnTagsChange();
        break;
      case "junkscore":
        HandleJunkStatusChanged(hdrToChange);
        break;
    }
  }
  onEvent(db, event) {}
}

/**
 * Initialize the nsIDBChangeListener when a new folder is selected in order to
 * listen for any flags change happening in the currently displayed messages.
 */
function initFolderDBListener() {
  // Bail out if we don't have a selected message, or we already have a
  // DBListener initialized and the folder didn't change.
  if (
    !gFolder ||
    (gFolderDBListener?.isRegistered &&
      gFolderDBListener.selectedFolder == gFolder)
  ) {
    return;
  }

  // Clearly we are viewing a different message in a different folder, so clear
  // any remaining of the old DBListener.
  clearFolderDBListener();

  gFolderDBListener = new FolderDBListener(gFolder);
  gFolderDBListener.register();
}

/**
 * Unregister the listener and clear the object if we already have one, meaning
 * the user just changed folder or deselected all messages.
 */
function clearFolderDBListener() {
  if (gFolderDBListener?.isRegistered) {
    gFolderDBListener.unregister();
    gFolderDBListener = null;
  }
}

/**
 * Our class constructor method which creates a header Entry based on an entry
 * in one of the header lists. A header entry is different from a header list.
 * A header list just describes how you want a particular header to be
 * presented. The header entry actually has knowledge about the DOM
 * and the actual DOM elements associated with the header.
 *
 * @param prefix  the name of the view (e.g. "expanded")
 * @param headerListInfo  entry from a header list.
 */
class MsgHeaderEntry {
  constructor(prefix, headerListInfo) {
    this.enclosingBox = document.getElementById(
      `${prefix}${headerListInfo.name}Box`
    );
    this.enclosingRow = this.enclosingBox.closest(".message-header-row");
    this.isNewHeader = false;
    this.valid = false;
    this.outputFunction = headerListInfo.outputFunction || updateHeaderValue;
  }
}

function initializeHeaderViewTables() {
  // Iterate over each header in our header list arrays and create header entries
  // for each one. These header entries are then stored in the appropriate header
  // table.
  for (let header of gExpandedHeaderList) {
    gExpandedHeaderView[header.name] = new MsgHeaderEntry("expanded", header);
  }

  let extraHeaders = Services.prefs
    .getCharPref("mailnews.headers.extraExpandedHeaders")
    .split(" ");
  for (let extraHeaderName of extraHeaders) {
    if (!extraHeaderName.trim()) {
      continue;
    }
    gExpandedHeaderView[extraHeaderName.toLowerCase()] = new HeaderView(
      extraHeaderName,
      extraHeaderName
    );
  }

  let otherHeaders = Services.prefs
    .getCharPref("mail.compose.other.header", "")
    .split(",")
    .map(h => h.trim())
    .filter(Boolean);

  for (let otherHeaderName of otherHeaders) {
    gExpandedHeaderView[otherHeaderName.toLowerCase()] = new HeaderView(
      otherHeaderName,
      otherHeaderName
    );
  }

  if (Services.prefs.getBoolPref("mailnews.headers.showOrganization")) {
    var organizationEntry = {
      name: "organization",
      outputFunction: updateHeaderValue,
    };
    gExpandedHeaderView[organizationEntry.name] = new MsgHeaderEntry(
      "expanded",
      organizationEntry
    );
  }

  if (Services.prefs.getBoolPref("mailnews.headers.showUserAgent")) {
    var userAgentEntry = {
      name: "user-agent",
      outputFunction: updateHeaderValue,
    };
    gExpandedHeaderView[userAgentEntry.name] = new MsgHeaderEntry(
      "expanded",
      userAgentEntry
    );
  }

  if (Services.prefs.getBoolPref("mailnews.headers.showMessageId")) {
    var messageIdEntry = {
      name: "message-id",
      outputFunction: outputMessageIds,
    };
    gExpandedHeaderView[messageIdEntry.name] = new MsgHeaderEntry(
      "expanded",
      messageIdEntry
    );
  }

  if (Services.prefs.getBoolPref("mailnews.headers.showSender")) {
    let senderEntry = {
      name: "sender",
      outputFunction: outputEmailAddresses,
    };
    gExpandedHeaderView[senderEntry.name] = new MsgHeaderEntry(
      "expanded",
      senderEntry
    );
  }
}

async function OnLoadMsgHeaderPane() {
  // Load any preferences that at are global with regards to
  // displaying a message...
  gMinNumberOfHeaders = Services.prefs.getIntPref(
    "mailnews.headers.minNumHeaders"
  );
  gShowCondensedEmailAddresses = Services.prefs.getBoolPref(
    "mail.showCondensedAddresses"
  );
  gHeadersShowReferences = Services.prefs.getBoolPref(
    "mailnews.headers.showReferences"
  );

  Services.obs.addObserver(MsgHdrViewObserver, "remote-content-blocked");
  Services.prefs.addObserver("mail.showCondensedAddresses", MsgHdrViewObserver);
  Services.prefs.addObserver(
    "mailnews.headers.showReferences",
    MsgHdrViewObserver
  );

  initializeHeaderViewTables();

  // Add the keyboard shortcut event listener for the message header.
  // Ctrl+Alt+S / Cmd+Control+S. We don't use the Alt/Option key on macOS
  // because it alters the pressed key to an ASCII character. See bug 1692263.
  let shortcut = await document.l10n.formatValue(
    "message-header-show-security-info-key"
  );
  document.addEventListener("keypress", event => {
    if (
      event.ctrlKey &&
      (event.altKey || event.metaKey) &&
      event.key.toLowerCase() == shortcut.toLowerCase()
    ) {
      showMessageReadSecurityInfo();
    }
  });

  // Set up event listeners for the encryption technology button and panel.
  document
    .getElementById("encryptionTechBtn")
    .addEventListener("click", showMessageReadSecurityInfo);
  let panel = document.getElementById("messageSecurityPanel");
  panel.addEventListener("popupshown", onMessageSecurityPopupShown);
  panel.addEventListener("popuphidden", onMessageSecurityPopupHidden);

  // Set the flag/star button on click listener.
  document
    .getElementById("starMessageButton")
    .addEventListener("click", MsgMarkAsFlagged);

  // Dispatch an event letting any listeners know that we have loaded
  // the message pane.
  let headerViewElement = document.getElementById("msgHeaderView");
  headerViewElement.loaded = true;
  headerViewElement.dispatchEvent(
    new Event("messagepane-loaded", { bubbles: false, cancelable: true })
  );

  content.addProgressListener(
    messageHeaderSink2,
    Ci.nsIWebProgress.NOTIFY_STATE_ALL
  );

  gHeaderCustomize.init();
}

function OnUnloadMsgHeaderPane() {
  let headerViewElement = document.getElementById("msgHeaderView");
  if (!headerViewElement.loaded) {
    // We're unloading, but we never loaded.
    return;
  }

  Services.obs.removeObserver(MsgHdrViewObserver, "remote-content-blocked");
  Services.prefs.removeObserver(
    "mail.showCondensedAddresses",
    MsgHdrViewObserver
  );
  Services.prefs.removeObserver(
    "mailnews.headers.showReferences",
    MsgHdrViewObserver
  );

  clearFolderDBListener();

  // Dispatch an event letting any listeners know that we have unloaded
  // the message pane.
  headerViewElement.dispatchEvent(
    new Event("messagepane-unloaded", { bubbles: false, cancelable: true })
  );
}

var MsgHdrViewObserver = {
  observe(subject, topic, data) {
    // verify that we're changing the mail pane config pref
    if (topic == "nsPref:changed") {
      if (data == "mail.showCondensedAddresses") {
        gShowCondensedEmailAddresses = Services.prefs.getBoolPref(
          "mail.showCondensedAddresses"
        );
        ReloadMessage();
      } else if (data == "mailnews.headers.showReferences") {
        gHeadersShowReferences = Services.prefs.getBoolPref(
          "mailnews.headers.showReferences"
        );
        ReloadMessage();
      }
    } else if (
      topic == "remote-content-blocked" &&
      content.browsingContext.id == data
    ) {
      gMessageNotificationBar.setRemoteContentMsg(
        null,
        subject,
        !gEncryptedSMIMEURIsService.isEncrypted(content.currentURI.spec)
      );
    }
  },
};

/**
 * The messageHeaderSink2 is the class that gets notified of a message's headers
 * as we display the message through our mime converter.
 */
var messageHeaderSink2 = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWebProgressListener",
    "nsISupportsWeakReference",
  ]),

  onStateChange(webProgress, request, stateFlags) {
    if (request instanceof Ci.nsIMailChannel) {
      request.QueryInterface(Ci.nsIMailChannel);
      if (stateFlags & Ci.nsIWebProgressListener.STATE_START) {
        request.smimeHeaderSink = smimeHeaderSink;
        this.onStartHeaders();
      } else if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
        currentCharacterSet = request.mailCharacterSet;
        request.QueryInterface(Ci.nsIChannel);
        request.smimeHeaderSink = null;
        this.processHeaders(request.headerNames, request.headerValues);
        if (request.imipItem) {
          calImipBar.showImipBar(request.imipItem, request.imipMethod);
        }
        for (let attachment of request.attachments) {
          this.handleAttachment(
            attachment.getProperty("contentType"),
            attachment.getProperty("url"),
            attachment.getProperty("displayName"),
            attachment.getProperty("uri"),
            attachment.getProperty("notDownloaded")
          );
          for (let key of [
            "X-Mozilla-PartURL",
            "X-Mozilla-PartSize",
            "X-Mozilla-PartDownloaded",
            "Content-Description",
            "Content-Type",
            "Content-Encoding",
          ]) {
            if (attachment.hasKey(key)) {
              this.addAttachmentField(key, attachment.getProperty(key));
            }
          }
        }
        this.onEndAllAttachments();
        let uri = request.URI.QueryInterface(Ci.nsIMsgMailNewsUrl);
        this.onEndMsgHeaders(uri);
        this.onEndMsgDownload(uri);
      }
    }
  },

  onStartHeaders() {
    // Every time we start to redisplay a message, check the view all headers
    // pref...
    let showAllHeadersPref = Services.prefs.getIntPref("mail.show_headers");
    if (showAllHeadersPref == 2) {
      // eslint-disable-next-line no-global-assign
      gViewAllHeaders = true;
    } else {
      if (gViewAllHeaders) {
        // If we currently are in view all header mode, rebuild our header
        // view so we remove most of the header data.
        hideHeaderView(gExpandedHeaderView);
        RemoveNewHeaderViews(gExpandedHeaderView);
        gDummyHeaderIdIndex = 0;
        // eslint-disable-next-line no-global-assign
        gExpandedHeaderView = {};
        initializeHeaderViewTables();
      }

      // eslint-disable-next-line no-global-assign
      gViewAllHeaders = false;
    }

    document.title = "";
    ClearCurrentHeaders();
    gBuiltExpandedView = false;
    gBuildAttachmentsForCurrentMsg = false;
    ClearAttachmentList();
    gMessageNotificationBar.clearMsgNotifications();

    // Reset the blocked hosts so we can populate it again for this message.
    document.getElementById("remoteContentOptions").value = "";

    for (let listener of gMessageListeners) {
      listener.onStartHeaders();
    }
  },

  onEndHeaders() {
    // Give add-ons a chance to modify currentHeaderData before it actually
    // gets displayed.
    for (let listener of gMessageListeners) {
      if ("onBeforeShowHeaderPane" in listener) {
        listener.onBeforeShowHeaderPane();
      }
    }

    // Load feed web page if so configured. This entry point works for
    // messagepane loads in 3pane folder tab, 3pane message tab, and the
    // standalone message window.
    if (!FeedMessageHandler.shouldShowSummary(gMessage, false)) {
      FeedMessageHandler.setContent(gMessage, false);
    }

    ShowMessageHeaderPane();
    // WARNING: This is the ONLY routine inside of the message Header Sink
    // that should trigger a reflow!
    ClearHeaderView(gExpandedHeaderView);

    // Make sure there is a subject even if it's empty so we'll show the
    // subject and the twisty.
    EnsureSubjectValue();

    // Make sure there is a from value even if empty so the header toolbar
    // will show up.
    EnsureFromValue();

    // Only update the expanded view if it's actually selected and needs updating.
    if (!gBuiltExpandedView) {
      UpdateExpandedMessageHeaders();
    }

    gMessageNotificationBar.setDraftEditMessage();
    UpdateJunkButton();

    for (let listener of gMessageListeners) {
      listener.onEndHeaders();
    }
  },

  processHeaders(headerNames, headerValues) {
    const kMailboxSeparator = ", ";
    var index = 0;
    for (let i = 0; i < headerNames.length; i++) {
      let header = {
        headerName: headerNames[i],
        headerValue: headerValues[i],
      };

      // For consistency's sake, let us force all header names to be lower
      // case so we don't have to worry about looking for: Cc and CC, etc.
      var lowerCaseHeaderName = header.headerName.toLowerCase();

      // If we have an x-mailer, x-mimeole, or x-newsreader string,
      // put it in the user-agent slot which we know how to handle already.
      if (/^x-(mailer|mimeole|newsreader)$/.test(lowerCaseHeaderName)) {
        lowerCaseHeaderName = "user-agent";
      }

      // See RFC 5322 section 3.6 for min-max number for given header.
      // If multiple headers exist we need to make sure to use the first one.

      if (lowerCaseHeaderName == "subject" && !document.title) {
        document.title = header.headerValue;
      }
      // according to RFC 2822, certain headers
      // can occur "unlimited" times
      if (lowerCaseHeaderName in currentHeaderData) {
        // Sometimes, you can have multiple To or Cc lines....
        // In this case, we want to append these headers into one.
        if (lowerCaseHeaderName == "to" || lowerCaseHeaderName == "cc") {
          currentHeaderData[lowerCaseHeaderName].headerValue =
            currentHeaderData[lowerCaseHeaderName].headerValue +
            "," +
            header.headerValue;
        } else {
          // Use the index to create a unique header name like:
          // received5, received6, etc
          currentHeaderData[lowerCaseHeaderName + index++] = header;
        }
      } else {
        currentHeaderData[lowerCaseHeaderName] = header;
      }
    } // while we have more headers to parse

    // Process message tags as if they were headers in the message.
    gMessageHeader.setTags();
    updateStarButton();

    if ("from" in currentHeaderData && "sender" in currentHeaderData) {
      let senderMailbox =
        kMailboxSeparator +
        MailServices.headerParser.extractHeaderAddressMailboxes(
          currentHeaderData.sender.headerValue
        ) +
        kMailboxSeparator;
      let fromMailboxes =
        kMailboxSeparator +
        MailServices.headerParser.extractHeaderAddressMailboxes(
          currentHeaderData.from.headerValue
        ) +
        kMailboxSeparator;
      if (fromMailboxes.includes(senderMailbox)) {
        delete currentHeaderData.sender;
      }
    }

    // We don't need to show the reply-to header if its value is either
    // the From field (totally pointless) or the To field (common for
    // mailing lists, but not that useful).
    if (
      "from" in currentHeaderData &&
      "to" in currentHeaderData &&
      "reply-to" in currentHeaderData
    ) {
      let replyToMailbox = MailServices.headerParser.extractHeaderAddressMailboxes(
        currentHeaderData["reply-to"].headerValue
      );
      let fromMailboxes = MailServices.headerParser.extractHeaderAddressMailboxes(
        currentHeaderData.from.headerValue
      );
      let toMailboxes = MailServices.headerParser.extractHeaderAddressMailboxes(
        currentHeaderData.to.headerValue
      );

      if (replyToMailbox == fromMailboxes || replyToMailbox == toMailboxes) {
        delete currentHeaderData["reply-to"];
      }
    }

    // For content-base urls stored uri encoded, we want to decode for
    // display (and encode for external link open).
    if ("content-base" in currentHeaderData) {
      currentHeaderData["content-base"].headerValue = decodeURI(
        currentHeaderData["content-base"].headerValue
      );
    }

    let expandedfromLabel = document.getElementById("expandedfromLabel");
    if (FeedUtils.isFeedMessage(gMessage)) {
      expandedfromLabel.value = expandedfromLabel.getAttribute("valueAuthor");
    } else {
      expandedfromLabel.value = expandedfromLabel.getAttribute("valueFrom");
    }

    this.onEndHeaders();
  },

  handleAttachment(contentType, url, displayName, uri, isExternalAttachment) {
    let newAttachment = new AttachmentInfo(
      contentType,
      url,
      displayName,
      uri,
      isExternalAttachment
    );
    currentAttachments.push(newAttachment);

    if (contentType == "application/pgp-keys" || displayName.endsWith(".asc")) {
      Enigmail.msg.autoProcessPgpKeyAttachment(newAttachment);
    }

    if (currentAttachments.length == 1) {
      // We also have to enable the Message/Attachments menuitem.
    }
  },

  addAttachmentField(field, value) {
    let last = currentAttachments[currentAttachments.length - 1];
    if (
      field == "X-Mozilla-PartSize" &&
      !last.isFileAttachment &&
      !last.isDeleted
    ) {
      let size = parseInt(value);

      if (last.isLinkAttachment) {
        // Check if an external link attachment's reported size is sane.
        // A size of < 2 isn't sensical so ignore such placeholder values.
        // Don't accept a size with any non numerics. Also cap the number.
        // We want the size to be checked again, upon user action, to make
        // sure size is updated with an accurate value, so |sizeResolved|
        // remains false.
        if (isNaN(size) || size.toString().length != value.length || size < 2) {
          last.size = -1;
        } else if (size > Number.MAX_SAFE_INTEGER) {
          last.size = Number.MAX_SAFE_INTEGER;
        } else {
          last.size = size;
        }
      } else {
        // For internal or file (detached) attachments, save the size.
        last.size = size;
        // For external file attachments, we won't have a valid size.
        if (!last.isFileAttachment && size > -1) {
          last.sizeResolved = true;
        }
      }
    } else if (field == "X-Mozilla-PartDownloaded" && value == "0") {
      // We haven't downloaded the attachment, so any size we get from
      // libmime is almost certainly inaccurate. Just get rid of it. (Note:
      // this relies on the fact that PartDownloaded comes after PartSize from
      // the MIME emitter.)
      // Note: for imap parts_on_demand, a small size consisting of the part
      // headers would have been returned above.
      last.size = -1;
      last.sizeResolved = false;
    }
  },

  onEndAllAttachments() {
    Enigmail.msg.notifyEndAllAttachments();

    displayAttachmentsForExpandedView();

    for (let listener of gMessageListeners) {
      if ("onEndAttachments" in listener) {
        listener.onEndAttachments();
      }
    }
  },

  /**
   * This event is generated by nsMsgStatusFeedback when it gets an
   * OnStateChange event for STATE_STOP.  This is the same event that
   * generates the "msgLoaded" property flag change event.  This best
   * corresponds to the end of the streaming process.
   */
  onEndMsgDownload(url) {
    let browser = getMessagePaneBrowser();
    if (
      currentAttachments.length &&
      Services.prefs.getBoolPref("mail.inline_attachments") &&
      FeedUtils.isFeedMessage(gMessage) &&
      browser &&
      browser.contentDocument &&
      browser.contentDocument.body
    ) {
      for (let img of browser.contentDocument.body.getElementsByClassName(
        "moz-attached-image"
      )) {
        for (let attachment of currentAttachments) {
          let partID = img.src.split("&part=")[1];
          partID = partID ? partID.split("&")[0] : null;
          if (attachment.partID && partID == attachment.partID) {
            img.src = attachment.url;
            break;
          }
        }

        img.addEventListener("load", function(event) {
          if (this.clientWidth > this.parentNode.clientWidth) {
            img.setAttribute("overflowing", "true");
            img.setAttribute("shrinktofit", "true");
          }
        });
      }
    }

    OnMsgParsed(url);
  },

  onEndMsgHeaders(url) {
    if (!url.errorCode) {
      // Should not mark a message as read if failed to load.
      OnMsgLoaded(url);
    }
  },
};

/**
 * Update the flagged (starred) state of the currently selected message.
 */
function updateStarButton() {
  if (!gMessage || !gFolder) {
    // No msgHdr to update, or we're dealing with an .eml.
    document.getElementById("starMessageButton").hidden = true;
    return;
  }

  let flagButton = document.getElementById("starMessageButton");
  flagButton.hidden = false;

  let isFlagged = gMessage.isFlagged;
  flagButton.classList.toggle("flagged", isFlagged);
  flagButton.setAttribute("aria-checked", isFlagged);
}

function EnsureSubjectValue() {
  if (!("subject" in currentHeaderData)) {
    let foo = {};
    foo.headerValue = "";
    foo.headerName = "subject";
    currentHeaderData[foo.headerName] = foo;
  }
}

function EnsureFromValue() {
  if (!("from" in currentHeaderData)) {
    let foo = {};
    foo.headerValue = "";
    foo.headerName = "from";
    currentHeaderData[foo.headerName] = foo;
  }
}

function OnTagsChange() {
  // rebuild the tag headers
  gMessageHeader.setTags();

  // Now update the expanded header view to rebuild the tags,
  // and then show or hide the tag header box.
  if (gBuiltExpandedView) {
    let headerEntry = gExpandedHeaderView.tags;
    if (headerEntry) {
      headerEntry.valid = "tags" in currentHeaderData;
      if (headerEntry.valid) {
        headerEntry.outputFunction(
          headerEntry,
          currentHeaderData.tags.headerValue
        );
      }

      // we may need to collapse or show the tag header row...
      headerEntry.enclosingRow.hidden = !headerEntry.valid;
      // ... and ensure that all headers remain correctly aligned
      gMessageHeader.syncLabelsColumnWidths();
    }
  }
}

/**
 * Flush out any local state being held by a header entry for a given table.
 *
 * @param aHeaderTable Table of header entries
 */
function ClearHeaderView(aHeaderTable) {
  for (let name in aHeaderTable) {
    let headerEntry = aHeaderTable[name];
    headerEntry.enclosingBox.clearHeaderValues?.();
    headerEntry.enclosingBox.clear?.();

    headerEntry.valid = false;
  }
}

/**
 * Make sure that any valid header entry in the table is collapsed.
 *
 * @param aHeaderTable Table of header entries
 */
function hideHeaderView(aHeaderTable) {
  for (let name in aHeaderTable) {
    let headerEntry = aHeaderTable[name];
    headerEntry.enclosingRow.hidden = true;
  }
}

/**
 * Make sure that any valid header entry in the table specified is visible.
 *
 * @param aHeaderTable Table of header entries
 */
function showHeaderView(aHeaderTable) {
  for (let name in aHeaderTable) {
    let headerEntry = aHeaderTable[name];
    headerEntry.enclosingRow.hidden = !headerEntry.valid;

    // If we're hiding the To field, we need to hide the date inline and show
    // the duplicate on the subject line.
    if (headerEntry.enclosingRow.id == "expandedtoRow") {
      let dateLabel = document.getElementById("dateLabel");
      let dateLabelSubject = document.getElementById("dateLabelSubject");
      if (!headerEntry.valid) {
        dateLabelSubject.setAttribute(
          "datetime",
          dateLabel.getAttribute("datetime")
        );
        dateLabelSubject.textContent = dateLabel.textContent;
        dateLabelSubject.hidden = false;
      } else {
        dateLabelSubject.removeAttribute("datetime");
        dateLabelSubject.textContent = "";
        dateLabelSubject.hidden = true;
      }
    }
  }
}

/**
 * Enumerate through the list of headers and find the number that are visible
 * add empty entries if we don't have the minimum number of rows.
 */
function EnsureMinimumNumberOfHeaders(headerTable) {
  // 0 means we don't have a minimum... do nothing special
  if (!gMinNumberOfHeaders) {
    return;
  }

  var numVisibleHeaders = 0;
  for (let name in headerTable) {
    let headerEntry = headerTable[name];
    if (headerEntry.valid) {
      numVisibleHeaders++;
    }
  }

  if (numVisibleHeaders < gMinNumberOfHeaders) {
    // How many empty headers do we need to add?
    var numEmptyHeaders = gMinNumberOfHeaders - numVisibleHeaders;

    // We may have already dynamically created our empty rows and we just need
    // to make them visible.
    for (let index in headerTable) {
      let headerEntry = headerTable[index];
      if (index.startsWith("Dummy-Header") && numEmptyHeaders) {
        headerEntry.valid = true;
        numEmptyHeaders--;
      }
    }

    // Ok, now if we have any extra dummy headers we need to add, create a new
    // header widget for them.
    while (numEmptyHeaders) {
      var dummyHeaderId = "Dummy-Header" + gDummyHeaderIdIndex;
      gExpandedHeaderView[dummyHeaderId] = new HeaderView(dummyHeaderId, "");
      gExpandedHeaderView[dummyHeaderId].valid = true;

      gDummyHeaderIdIndex++;
      numEmptyHeaders--;
    }
  }
}

/**
 * Make sure the appropriate fields in the expanded header view are collapsed
 * or visible...
 */
function updateExpandedView() {
  if (gMinNumberOfHeaders) {
    EnsureMinimumNumberOfHeaders(gExpandedHeaderView);
  }
  showHeaderView(gExpandedHeaderView);

  // Now that we have all the headers, ensure that the name columns of both
  // grids are the same size so that they don't look weird.
  gMessageHeader.syncLabelsColumnWidths();

  UpdateJunkButton();
  UpdateReplyButtons();
  displayAttachmentsForExpandedView();

  try {
    AdjustHeaderView(Services.prefs.getIntPref("mail.show_headers"));
  } catch (e) {
    console.error(e);
  }
}

/**
 * Default method for updating a header value into a header entry
 *
 * @param aHeaderEntry  A single header from currentHeaderData
 * @param aHeaderValue  The new value for headerEntry
 */
function updateHeaderValue(aHeaderEntry, aHeaderValue) {
  aHeaderEntry.enclosingBox.headerValue = aHeaderValue;
}

/**
 * Create the DOM nodes (aka "View") for a non-standard header and insert them
 * into the grid.  Create and return the corresponding headerEntry object.
 *
 * @param {string} headerName - name of the header we're adding, used to
 *                             construct the element IDs (in lower case)
 * @param {string} label - name of the header as displayed in the UI
 */
class HeaderView {
  constructor(headerName, label) {
    headerName = headerName.toLowerCase();
    let rowId = "expanded" + headerName + "Row";
    let idName = "expanded" + headerName + "Box";
    let newHeaderNode;
    // If a row for this header already exists, do not create another one.
    let newRowNode = document.getElementById(rowId);
    if (!newRowNode) {
      // Create new collapsed row.
      newRowNode = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div"
      );
      newRowNode.setAttribute("id", rowId);
      newRowNode.classList.add("message-header-row");
      newRowNode.hidden = true;

      // Create and append the label which contains the header name.
      let newLabelNode = document.createXULElement("label");
      newLabelNode.setAttribute("id", "expanded" + headerName + "Label");
      newLabelNode.setAttribute("value", label);
      newLabelNode.setAttribute("class", "message-header-label");

      newRowNode.appendChild(newLabelNode);

      // Create and append the new header value.
      newHeaderNode = document.createElement("div", {
        is: "simple-header-row",
      });
      newHeaderNode.setAttribute("id", idName);
      newHeaderNode.dataset.prettyHeaderName = label;
      newHeaderNode.dataset.headerName = headerName;
      newRowNode.appendChild(newHeaderNode);

      // Add the new row to the extra headers container.
      document.getElementById("extraHeadersArea").appendChild(newRowNode);
      this.isNewHeader = true;
    } else {
      newRowNode.hidden = true;
      newHeaderNode = document.getElementById(idName);
      this.isNewHeader = false;
    }

    this.enclosingBox = newHeaderNode;
    this.enclosingRow = newRowNode;
    this.valid = false;
    this.outputFunction = updateHeaderValue;
  }
}

/**
 * Removes all non-predefined header nodes from the view.
 *
 * @param aHeaderTable  Table of header entries.
 */
function RemoveNewHeaderViews(aHeaderTable) {
  for (let name in aHeaderTable) {
    let headerEntry = aHeaderTable[name];
    if (headerEntry.isNewHeader) {
      headerEntry.enclosingRow.remove();
    }
  }
}

/**
 * UpdateExpandedMessageHeaders: Iterate through all the current header data
 * we received from mime for this message for the expanded header entry table,
 * and see if we have a corresponding entry for that header (i.e.
 * whether the expanded header view cares about this header value)
 * If so, then call updateHeaderEntry
 */
function UpdateExpandedMessageHeaders() {
  // Iterate over each header we received and see if we have a matching entry
  // in each header view table...
  var headerName;

  // Remove the height attr so that it redraws correctly. Works around a problem
  // that attachment-splitter causes if it's moved high enough to affect
  // the header box:
  document.getElementById("msgHeaderView").removeAttribute("height");
  // This height attribute may be set by toggleWrap() if the user clicked
  // the "more" button" in the header.
  // Remove it so that the height is determined automatically.

  for (headerName in currentHeaderData) {
    var headerField = currentHeaderData[headerName];
    var headerEntry = null;

    if (headerName in gExpandedHeaderView) {
      headerEntry = gExpandedHeaderView[headerName];
    }

    if (!headerEntry && gViewAllHeaders) {
      // For view all headers, if we don't have a header field for this
      // value, cheat and create one then fill in a headerEntry.
      if (headerName == "message-id" || headerName == "in-reply-to") {
        var messageIdEntry = {
          name: headerName,
          outputFunction: outputMessageIds,
        };
        gExpandedHeaderView[headerName] = new MsgHeaderEntry(
          "expanded",
          messageIdEntry
        );
      } else if (headerName != "x-mozilla-localizeddate") {
        // Don't bother showing X-Mozilla-LocalizedDate, since that value is
        // displayed below the message header toolbar.
        gExpandedHeaderView[headerName] = new HeaderView(
          headerName,
          currentHeaderData[headerName].headerName
        );
      }

      headerEntry = gExpandedHeaderView[headerName];
    }

    if (headerEntry) {
      if (
        headerName == "references" &&
        !(
          gViewAllHeaders ||
          gHeadersShowReferences ||
          gFolder?.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false)
        )
      ) {
        // Hide references header if view all headers mode isn't selected, the
        // pref show references is deactivated and the currently displayed
        // message isn't a newsgroup posting.
        headerEntry.valid = false;
      } else {
        // Set the row element visible before populating the field with addresses.
        headerEntry.enclosingRow.hidden = false;
        headerEntry.outputFunction(headerEntry, headerField.headerValue);
        headerEntry.valid = true;
      }
    }
  }

  let otherHeaders = Services.prefs
    .getCharPref("mail.compose.other.header", "")
    .split(",")
    .map(h => h.trim())
    .filter(Boolean);

  for (let otherHeaderName of otherHeaders) {
    let toLowerCaseHeaderName = otherHeaderName.toLowerCase();
    let headerEntry = gExpandedHeaderView[toLowerCaseHeaderName];
    let headerData = currentHeaderData[toLowerCaseHeaderName];

    if (headerEntry && headerData) {
      headerEntry.outputFunction(headerEntry, headerData.headerValue);
      headerEntry.valid = true;
    }
  }

  let dateLabel = document.getElementById("dateLabel");
  dateLabel.hidden = true;
  if (
    "x-mozilla-localizeddate" in currentHeaderData &&
    currentHeaderData["x-mozilla-localizeddate"].headerValue
  ) {
    dateLabel.textContent =
      currentHeaderData["x-mozilla-localizeddate"].headerValue;
    let date = new Date(currentHeaderData.date.headerValue);
    if (!isNaN(date)) {
      dateLabel.setAttribute("datetime", date.toISOString());
      dateLabel.hidden = false;
    }
  }

  gBuiltExpandedView = true;

  // Now update the view to make sure the right elements are visible.
  updateExpandedView();
}

function ClearCurrentHeaders() {
  gSecureMsgProbe = {};
  // eslint-disable-next-line no-global-assign
  currentHeaderData = {};
  // eslint-disable-next-line no-global-assign
  currentAttachments = [];
  currentCharacterSet = "";
}

function ShowMessageHeaderPane() {
  document.getElementById("msgHeaderView").collapsed = false;
  document.getElementById("mail-notification-top").collapsed = false;

  // Initialize the DBListener if we don't have one. This might happen when the
  // message pane is hidden or no message was selected before, which caused the
  // clearing of the the DBListener.
  initFolderDBListener();
}

function HideMessageHeaderPane() {
  let header = document.getElementById("msgHeaderView");
  header.collapsed = true;
  document.getElementById("mail-notification-top").collapsed = true;

  // Disable the attachment box.
  document.getElementById("attachmentView").collapsed = true;
  document.getElementById("attachment-splitter").collapsed = true;

  gMessageNotificationBar.clearMsgNotifications();
  // Clear the DBListener since we don't have any visible UI to update.
  clearFolderDBListener();

  // Now let interested listeners know the pane has been hidden.
  header.dispatchEvent(new Event("message-header-pane-hidden"));
}

/**
 * Take a string of newsgroups separated by commas, split it into newsgroups and
 * add them to the corresponding header-newsgroups-row element.
 *
 * @param {MsgHeaderEntry} headerEntry - The data structure for this header.
 * @param {string} headerValue - The string of newsgroups from the message.
 */
function outputNewsgroups(headerEntry, headerValue) {
  headerValue
    .split(",")
    .forEach(newsgroup => headerEntry.enclosingBox.addNewsgroup(newsgroup));
  headerEntry.enclosingBox.buildView();
}

/**
 * Take a string of tags separated by space, split them and add them to the
 * corresponding header-tags-row element.
 *
 * @param {MsgHeaderEntry} headerEntry - The data structure for this header.
 * @param {string} headerValue - The string of tags from the message.
 */
function outputTags(headerEntry, headerValue) {
  headerEntry.enclosingBox.buildTags(headerValue.split(" "));
}

/**
 * Take a string of message-ids separated by whitespace, split it and send them
 * to the corresponding header-message-ids-row element.
 *
 * @param {MsgHeaderEntry} headerEntry - The data structure for this header.
 * @param {string} headerValue - The string of message IDs from the message.
 */
function outputMessageIds(headerEntry, headerValue) {
  headerEntry.enclosingBox.clear();

  for (let id of headerValue.split(/\s+/)) {
    headerEntry.enclosingBox.addId(id);
  }

  headerEntry.enclosingBox.buildView();
}

/**
 * Take a string of addresses separated by commas, split it into separated
 * recipient objects and add them to the related parent container row.
 *
 * @param {MsgHeaderEntry} headerEntry - The data structure for this header.
 * @param {string} emailAddresses - The string of addresses from the message.
 */
function outputEmailAddresses(headerEntry, emailAddresses) {
  if (!emailAddresses) {
    return;
  }

  // The email addresses are still RFC2047 encoded but libmime has already
  // converted from "raw UTF-8" to "wide" (UTF-16) characters.
  let addresses = MailServices.headerParser.parseEncodedHeaderW(emailAddresses);

  // Make sure we start clean.
  headerEntry.enclosingBox.clear();

  // No addresses and a colon, so an empty group like "undisclosed-recipients: ;".
  // Add group name so at least something displays.
  if (!addresses.length && emailAddresses.includes(":")) {
    let address = { displayName: emailAddresses };
    headerEntry.enclosingBox.addRecipient(address);
  }

  for (let addr of addresses) {
    // If we want to include short/long toggle views and we have a long view,
    // always add it. If we aren't including a short/long view OR if we are and
    // we haven't parsed enough addresses to reach the cutoff valve yet then add
    // it to the default (short) div.
    let address = {};
    address.emailAddress = addr.email;
    address.fullAddress = addr.toString();
    address.displayName = addr.name;
    headerEntry.enclosingBox.addRecipient(address);
  }

  headerEntry.enclosingBox.buildView();
}

/**
 * Create a new attachment object which goes into the data attachment array.
 * This method checks whether the passed attachment is empty or not.
 *
 * @param {string} contentType - The attachment's mimetype.
 * @param {string} url - The URL for the attachment.
 * @param {string} name - The name to be displayed for this attachment
 *                               (usually the filename).
 * @param {string} uri - The URI for the message containing the attachment.
 * @param {boolean} isExternalAttachment - True if the attachment has been
 *                                         detached to file or is a link
 *                                         attachment.
 */
function AttachmentInfo(contentType, url, name, uri, isExternalAttachment) {
  this.message = gMessage;
  this.contentType = contentType;
  this.name = name;
  this.url = url;
  this.uri = uri;
  this.isExternalAttachment = isExternalAttachment;
  // A |size| value of -1 means we don't have a valid size. Check again if
  // |sizeResolved| is false. For internal attachments and link attachments
  // with a reported size, libmime streams values to addAttachmentField()
  // which updates this object. For external file attachments, |size| is updated
  // in the isEmpty() function when the list is built. Deleted attachments
  // are resolved to -1.
  this.size = -1;
  this.sizeResolved = this.isDeleted;

  // Remove [?&]part= from remote urls, after getting the partID.
  // Remote urls, unlike non external mail part urls, may also contain query
  // strings starting with ?; PART_RE does not handle this.
  if (this.isLinkAttachment || this.isFileAttachment) {
    let match = url.match(/[?&]part=[^&]+$/);
    match = match && match[0];
    this.partID = match && match.split("part=")[1];
    this.url = url.replace(match, "");
  } else {
    let match = GlodaUtils.PART_RE.exec(url);
    this.partID = match && match[1];
  }
}

AttachmentInfo.prototype = {
  /**
   * Save this attachment to a file.
   */
  async save() {
    if (!this.hasFile || this.message != gMessage) {
      return;
    }

    let empty = await this.isEmpty();
    if (empty) {
      return;
    }

    top.messenger.saveAttachment(
      this.contentType,
      this.url,
      encodeURIComponent(this.name),
      this.uri,
      this.isExternalAttachment
    );
  },

  /**
   * Open this attachment.
   */
  async open() {
    if (!this.hasFile || this.message != gMessage) {
      return;
    }

    let bundleMessenger = document.getElementById("bundle_messenger");
    let empty = await this.isEmpty();
    if (empty) {
      let prompt = bundleMessenger.getString(
        this.isExternalAttachment
          ? "externalAttachmentNotFound"
          : "emptyAttachment"
      );
      top.msgWindow.promptDialog.alert(null, prompt);
    } else {
      // @see MsgComposeCommands.js which has simililar opening functionality
      let dotPos = this.name.lastIndexOf(".");
      let extension =
        dotPos >= 0 ? this.name.substring(dotPos + 1).toLowerCase() : "";
      if (this.contentType == "application/pdf" || extension == "pdf") {
        let handlerInfo = gMIMEService.getFromTypeAndExtension(
          this.contentType,
          extension
        );
        // Only open a new tab for pdfs if we are handling them internally.
        if (
          !handlerInfo.alwaysAskBeforeHandling &&
          handlerInfo.preferredAction == Ci.nsIHandlerInfo.handleInternally
        ) {
          // Add the content type to avoid a "how do you want to open this?"
          // dialog. The type may already be there, but that doesn't matter.
          let url = this.url;
          if (!url.includes("type=")) {
            url += url.includes("?") ? "&" : "?";
            url += "type=application/pdf";
          }
          let tabmail = document.getElementById("tabmail");
          if (!tabmail) {
            // If no tabmail available in this window, try and find it in
            // another.
            let win = Services.wm.getMostRecentWindow("mail:3pane");
            tabmail = win && win.document.getElementById("tabmail");
          }
          if (tabmail) {
            tabmail.openTab("contentTab", {
              url,
              background: false,
              linkHandler: "single-page",
            });
            tabmail.ownerGlobal.focus();
            return;
          }
          // If no tabmail, open PDF same as other attachments.
        }
      }

      // Just use the old method for handling messages, it works.

      let { name, url } = this;

      async function saveToFile(path) {
        let buffer = await new Promise(function(resolve, reject) {
          NetUtil.asyncFetch(
            {
              uri: Services.io.newURI(url),
              loadUsingSystemPrincipal: true,
            },
            function(inputStream, status) {
              if (Components.isSuccessCode(status)) {
                resolve(NetUtil.readInputStream(inputStream));
              } else {
                reject(
                  new Components.Exception("Failed to fetch attachment", status)
                );
              }
            }
          );
        });
        await IOUtils.write(path, new Uint8Array(buffer));
      }

      if (this.contentType == "message/rfc822") {
        let tempFile = AttachmentInfo._temporaryFiles.get(url);
        if (!tempFile?.exists()) {
          tempFile = Services.dirsvc.get("TmpD", Ci.nsIFile);
          tempFile.append("subPart.eml");
          tempFile.createUnique(0, 0o600);
          saveToFile(tempFile.path);

          AttachmentInfo._temporaryFiles.set(url, tempFile);
        }

        top.MsgOpenEMLFile(tempFile, Services.io.newFileURI(tempFile));
        return;
      }

      // Get the MIME info from the service.

      let mimeInfo;
      try {
        mimeInfo = gMIMEService.getFromTypeAndExtension(
          this.contentType,
          extension
        );
      } catch (ex) {
        // If the call above fails, which can happen on Windows where there's
        // nothing registered for the file type, assume this generic type.
        mimeInfo = gMIMEService.getFromTypeAndExtension(
          "application/octet-stream",
          ""
        );
      }
      // The default action is saveToDisk, which is not what we want.
      // If we don't have a stored handler, ask before handling.
      if (!gHandlerService.exists(mimeInfo)) {
        mimeInfo.alwaysAskBeforeHandling = true;
        mimeInfo.preferredAction = Ci.nsIHandlerInfo.alwaysAsk;
      }

      // If we know what to do, do it.

      name = DownloadPaths.sanitize(name);

      let createTemporaryFileAndOpen = async mimeInfo => {
        let tmpPath = PathUtils.join(
          Services.dirsvc.get("TmpD", Ci.nsIFile).path,
          "pid-" + Services.appinfo.processID
        );
        await IOUtils.makeDirectory(tmpPath, { permissions: 0o700 });
        let tempFile = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        tempFile.initWithPath(tmpPath);

        tempFile.append(name);
        tempFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
        tempFile.remove(false);

        Cc["@mozilla.org/uriloader/external-helper-app-service;1"]
          .getService(Ci.nsPIExternalAppLauncher)
          .deleteTemporaryFileOnExit(tempFile);

        await saveToFile(tempFile.path);
        // Before opening from the temp dir, make the file read only so that
        // users don't edit and lose their edits...
        tempFile.permissions = 0o400;
        this._openFile(mimeInfo, tempFile);
      };

      let openLocalFile = mimeInfo => {
        let fileHandler = Services.io
          .getProtocolHandler("file")
          .QueryInterface(Ci.nsIFileProtocolHandler);

        try {
          let externalFile = fileHandler.getFileFromURLSpec(this.displayUrl);
          this._openFile(mimeInfo, externalFile);
        } catch (ex) {
          console.error(
            "AttachmentInfo.open: file - " + this.displayUrl + ", " + ex
          );
        }
      };

      if (!mimeInfo.alwaysAskBeforeHandling) {
        switch (mimeInfo.preferredAction) {
          case Ci.nsIHandlerInfo.saveToDisk:
            if (Services.prefs.getBoolPref("browser.download.useDownloadDir")) {
              let destFile = new FileUtils.File(
                await Downloads.getPreferredDownloadsDirectory()
              );
              destFile.append(name);
              destFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o755);
              destFile.remove(false);
              await saveToFile(destFile.path);
            } else {
              let filePicker = Cc["@mozilla.org/filepicker;1"].createInstance(
                Ci.nsIFilePicker
              );
              filePicker.defaultString = this.name;
              filePicker.defaultExtension = extension;
              filePicker.init(
                window.browsingContext.topChromeWindow,
                bundleMessenger.getString("SaveAttachment"),
                Ci.nsIFilePicker.modeSave
              );
              let rv = await new Promise(resolve => filePicker.open(resolve));
              if (rv != Ci.nsIFilePicker.returnCancel) {
                await saveToFile(filePicker.file.path);
              }
            }
            return;
          case Ci.nsIHandlerInfo.useHelperApp:
          case Ci.nsIHandlerInfo.useSystemDefault:
            // Attachments can be detached and, if this is the case, opened from
            // their location on disk instead of copied to a temporary file.
            if (this.isExternalAttachment) {
              openLocalFile(mimeInfo);

              return;
            }

            await createTemporaryFileAndOpen(mimeInfo);
            return;
        }
      }

      // Ask what to do, then do it.
      let appLauncherDialog = Cc[
        "@mozilla.org/helperapplauncherdialog;1"
      ].createInstance(Ci.nsIHelperAppLauncherDialog);
      appLauncherDialog.show(
        {
          QueryInterface: ChromeUtils.generateQI(["nsIHelperAppLauncher"]),
          MIMEInfo: mimeInfo,
          source: Services.io.newURI(this.url),
          suggestedFileName: this.name,
          cancel(reason) {},
          promptForSaveDestination() {
            appLauncherDialog.promptForSaveToFileAsync(
              this,
              window.browsingContext.topChromeWindow,
              this.suggestedFileName,
              "." + extension, // Dot stripped by promptForSaveToFileAsync.
              false
            );
          },
          launchLocalFile() {
            openLocalFile(mimeInfo);
          },
          async setDownloadToLaunch(handleInternally, file) {
            await createTemporaryFileAndOpen(mimeInfo);
          },
          async saveDestinationAvailable(file) {
            if (file) {
              await saveToFile(file.path);
            }
          },
          setWebProgressListener(webProgressListener) {},
          targetFile: null,
          targetFileIsExecutable: null,
          timeDownloadStarted: null,
          contentLength: this.size,
          browsingContextId: getMessagePaneBrowser().browsingContext.id,
        },
        window.browsingContext.topChromeWindow,
        null
      );
    }
  },

  /**
   * Unless overridden by a test, opens a saved attachment when called by `open`.
   *
   * @param {nsIMIMEInfo} mimeInfo
   * @param {nsIFile} file
   */
  _openFile(mimeInfo, file) {
    mimeInfo.launchWithFile(file);
  },

  /**
   * Detach this attachment from the message.
   *
   * @param {boolean} aSaveFirst - true if the attachment should be saved
   *                               before detaching, false otherwise.
   */
  detach(aSaveFirst) {
    top.messenger.detachAttachment(
      this.contentType,
      this.url,
      encodeURIComponent(this.name),
      this.uri,
      aSaveFirst
    );
  },

  /**
   * This method checks whether the attachment has been deleted or not.
   *
   * @returns true if the attachment has been deleted, false otherwise.
   */
  get isDeleted() {
    return this.contentType == "text/x-moz-deleted";
  },

  /**
   * This method checks whether the attachment is a detached file.
   *
   * @returns true if the attachment is a detached file, false otherwise.
   */
  get isFileAttachment() {
    return this.isExternalAttachment && this.url.startsWith("file:");
  },

  /**
   * This method checks whether the attachment is an http link.
   *
   * @returns true if the attachment is an http link, false otherwise.
   */
  get isLinkAttachment() {
    return this.isExternalAttachment && /^https?:/.test(this.url);
  },

  /**
   * This method checks whether the attachment has an associated file or not.
   * Deleted attachments or detached attachments with missing external files
   * do *not* have a file.
   *
   * @returns true if the attachment has an associated file, false otherwise.
   */
  get hasFile() {
    if (this.sizeResolved && this.size == -1) {
      return false;
    }

    return true;
  },

  /**
   * Return display url, decoded and converted to utf8 from IDN punycode ascii,
   * if the attachment is external (http or file schemes).
   *
   * @returns {string} url.
   */
  get displayUrl() {
    if (this.isExternalAttachment) {
      // For status bar url display purposes, we want the displaySpec.
      // The ?part= has already been removed.
      return decodeURI(makeURI(this.url).displaySpec);
    }

    return this.url;
  },

  /**
   * This method checks whether the attachment url location exists and
   * is accessible. For http and file urls, fetch() will have the size
   * in the content-length header.
   *
   * @returns true if the attachment is empty or error, false otherwise.
   */
  async isEmpty() {
    if (this.isDeleted) {
      return true;
    }

    const isFetchable = url => {
      let uri = makeURI(url);
      return !(uri.username || uri.userPass);
    };

    // We have a resolved size.
    if (this.sizeResolved) {
      return this.size < 1;
    }

    if (!isFetchable(this.url)) {
      return false;
    }

    let empty = true;
    let size = -1;
    let options = { method: "GET" };

    let request = new Request(this.url, options);

    if (this.isExternalAttachment) {
      updateAttachmentsDisplay(this, true);
    }

    await fetch(request)
      .then(response => {
        if (!response.ok) {
          console.warn(
            "AttachmentInfo.isEmpty: fetch response error - " +
              response.statusText +
              ", response.url - " +
              response.url
          );
          return null;
        }

        if (this.isLinkAttachment) {
          if (response.status < 200 || response.status > 304) {
            console.warn(
              "AttachmentInfo.isEmpty: link fetch response status - " +
                response.status +
                ", response.url - " +
                response.url
            );
            return null;
          }
        }

        return response;
      })
      .then(async response => {
        if (this.isExternalAttachment) {
          size = response ? response.headers.get("content-length") : -1;
        } else {
          // Check the attachment again if addAttachmentField() sets a
          // libmime -1 return value for size in this object.
          // Note: just test for a non zero size, don't need to drain the
          // stream. We only get here if the url is fetchable.
          // The size for internal attachments is not calculated here but
          // will come from libmime.
          let reader = response.body.getReader();
          let result = await reader.read();
          reader.cancel();
          size = result && result.value ? result.value.length : -1;
        }

        if (size > 0) {
          empty = false;
        }
      })
      .catch(error => {
        console.warn(
          `AttachmentInfo.isEmpty: ${error.message} url - ${this.url}`
        );
      });

    this.sizeResolved = true;

    if (this.isExternalAttachment) {
      // For link attachments, we may have had a published value or -1
      // indicating unknown value. We now know the real size, so set it and
      // update the ui. For detached file attachments, get the size here
      // instead of the old xpcom way.
      this.size = size;
      updateAttachmentsDisplay(this, false);
    }

    return empty;
  },

  /**
   * Open a file attachment's containing folder.
   */
  openFolder() {
    if (!this.isFileAttachment || !this.hasFile) {
      return;
    }

    // The file url is stored in the attachment info part with unix path and
    // needs to be converted to os path for nsIFile.
    let fileHandler = Services.io
      .getProtocolHandler("file")
      .QueryInterface(Ci.nsIFileProtocolHandler);
    try {
      fileHandler.getFileFromURLSpec(this.displayUrl).reveal();
    } catch (ex) {
      console.error(
        "AttachmentInfo.openFolder: file - " + this.displayUrl + ", " + ex
      );
    }
  },
};

/**
 * A cache of message/rfc822 attachments saved to temporary files for display.
 * Saving the same attachment again is avoided.
 *
 * @type {Map<string, nsIFile>}
 */
AttachmentInfo._temporaryFiles = new Map();

/**
 * Return true if possible attachments in the currently loaded message can be
 * deleted/detached.
 */
function CanDetachAttachments() {
  var canDetach =
    !gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false) &&
    (!gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.ImapBox, false) ||
      MailOfflineMgr.isOnline()) &&
    gFolder; // We can't detach from loaded eml files yet.
  if (canDetach && "content-type" in currentHeaderData) {
    canDetach = !ContentTypeIsSMIME(
      currentHeaderData["content-type"].headerValue
    );
  }

  return canDetach;
}

/**
 * Return true if the content type is an S/MIME one.
 */
function ContentTypeIsSMIME(contentType) {
  // S/MIME is application/pkcs7-mime and application/pkcs7-signature
  // - also match application/x-pkcs7-mime and application/x-pkcs7-signature.
  return /application\/(x-)?pkcs7-(mime|signature)/.test(contentType);
}

function onShowAttachmentToolbarContextMenu() {
  let expandBar = document.getElementById("context-expandAttachmentBar");
  let expanded = Services.prefs.getBoolPref(
    "mailnews.attachments.display.start_expanded"
  );
  expandBar.setAttribute("checked", expanded);
}

/**
 * Set up the attachment item context menu, showing or hiding the appropriate
 * menu items.
 */
function onShowAttachmentItemContextMenu() {
  let attachmentList = document.getElementById("attachmentList");
  let attachmentInfo = document.getElementById("attachmentInfo");
  let attachmentName = document.getElementById("attachmentName");
  let contextMenu = document.getElementById("attachmentItemContext");
  let openMenu = document.getElementById("context-openAttachment");
  let saveMenu = document.getElementById("context-saveAttachment");
  let detachMenu = document.getElementById("context-detachAttachment");
  let deleteMenu = document.getElementById("context-deleteAttachment");
  let copyUrlMenuSep = document.getElementById(
    "context-menu-copyurl-separator"
  );
  let copyUrlMenu = document.getElementById("context-copyAttachmentUrl");
  let openFolderMenu = document.getElementById("context-openFolder");

  // If we opened the context menu from the attachment info area (the paperclip,
  // "1 attachment" label, filename, or file size, just grab the first (and
  // only) attachment as our "selected" attachments.
  var selectedAttachments;
  if (
    contextMenu.triggerNode == attachmentInfo ||
    contextMenu.triggerNode.parentNode == attachmentInfo
  ) {
    selectedAttachments = [attachmentList.getItemAtIndex(0).attachment];
    if (contextMenu.triggerNode == attachmentName) {
      attachmentName.setAttribute("selected", true);
    }
  } else {
    selectedAttachments = [...attachmentList.selectedItems].map(
      item => item.attachment
    );
  }
  contextMenu.attachments = selectedAttachments;

  var allSelectedDetached = selectedAttachments.every(function(attachment) {
    return attachment.isExternalAttachment;
  });
  var allSelectedDeleted = selectedAttachments.every(function(attachment) {
    return !attachment.hasFile;
  });
  var canDetachSelected =
    CanDetachAttachments() && !allSelectedDetached && !allSelectedDeleted;
  let allSelectedHttp = selectedAttachments.every(function(attachment) {
    return attachment.isLinkAttachment;
  });
  let allSelectedFile = selectedAttachments.every(function(attachment) {
    return attachment.isFileAttachment;
  });

  openMenu.disabled = allSelectedDeleted;
  saveMenu.disabled = allSelectedDeleted;
  detachMenu.disabled = !canDetachSelected;
  deleteMenu.disabled = !canDetachSelected;
  copyUrlMenuSep.hidden = copyUrlMenu.hidden = !(
    allSelectedHttp || allSelectedFile
  );
  openFolderMenu.hidden = !allSelectedFile;
  openFolderMenu.disabled = allSelectedDeleted;

  Enigmail.hdrView.onShowAttachmentContextMenu();
}

/**
 * Close the attachment item context menu, performing any cleanup as necessary.
 */
function onHideAttachmentItemContextMenu() {
  let attachmentName = document.getElementById("attachmentName");
  let contextMenu = document.getElementById("attachmentItemContext");

  // If we opened the context menu from the attachmentName label, we need to
  // get rid of the "selected" attribute.
  if (contextMenu.triggerNode == attachmentName) {
    attachmentName.removeAttribute("selected");
  }
}

/**
 * Enable/disable menu items as appropriate for the single-attachment save all
 * toolbar button.
 */
function onShowSaveAttachmentMenuSingle() {
  let openItem = document.getElementById("button-openAttachment");
  let saveItem = document.getElementById("button-saveAttachment");
  let detachItem = document.getElementById("button-detachAttachment");
  let deleteItem = document.getElementById("button-deleteAttachment");

  let detached = currentAttachments[0].isExternalAttachment;
  let deleted = !currentAttachments[0].hasFile;
  let canDetach = CanDetachAttachments() && !deleted && !detached;

  openItem.disabled = deleted;
  saveItem.disabled = deleted;
  detachItem.disabled = !canDetach;
  deleteItem.disabled = !canDetach;
}

/**
 * Enable/disable menu items as appropriate for the multiple-attachment save all
 * toolbar button.
 */
function onShowSaveAttachmentMenuMultiple() {
  let openAllItem = document.getElementById("button-openAllAttachments");
  let saveAllItem = document.getElementById("button-saveAllAttachments");
  let detachAllItem = document.getElementById("button-detachAllAttachments");
  let deleteAllItem = document.getElementById("button-deleteAllAttachments");

  let allDetached = currentAttachments.every(function(attachment) {
    return attachment.isExternalAttachment;
  });
  let allDeleted = currentAttachments.every(function(attachment) {
    return !attachment.hasFile;
  });
  let canDetach = CanDetachAttachments() && !allDeleted && !allDetached;

  openAllItem.disabled = allDeleted;
  saveAllItem.disabled = allDeleted;
  detachAllItem.disabled = !canDetach;
  deleteAllItem.disabled = !canDetach;
}

/**
 * This is our oncommand handler for the attachment list items. A double click
 * or enter press in an attachmentitem simulates "opening" the attachment.
 *
 * @param event  the event object
 */
function attachmentItemCommand(event) {
  HandleSelectedAttachments("open");
}

var AttachmentListController = {
  supportsCommand(command) {
    switch (command) {
      case "cmd_selectAll":
      case "cmd_delete":
      case "cmd_shiftDelete":
      case "cmd_saveAsFile":
        return true;
      default:
        return false;
    }
  },

  isCommandEnabled(command) {
    switch (command) {
      case "cmd_selectAll":
      case "cmd_delete":
      case "cmd_shiftDelete":
      case "cmd_saveAsFile":
        return true;
      default:
        return false;
    }
  },

  doCommand(command) {
    // If the user invoked a key short cut then it is possible that we got here
    // for a command which is really disabled. kick out if the command should
    // be disabled.
    if (!this.isCommandEnabled(command)) {
      return;
    }

    var attachmentList = document.getElementById("attachmentList");

    switch (command) {
      case "cmd_selectAll":
        attachmentList.selectAll();
        return;
      case "cmd_delete":
      case "cmd_shiftDelete":
        HandleSelectedAttachments("delete");
        return;
      case "cmd_saveAsFile":
        HandleSelectedAttachments("saveAs");
    }
  },

  onEvent(event) {},
};

var AttachmentMenuController = {
  commands: {
    cmd_openAllAttachments: {
      isEnabled() {
        return AttachmentMenuController._someFilesAvailable();
      },

      doCommand() {
        HandleAllAttachments("open");
      },
    },

    cmd_saveAllAttachments: {
      isEnabled() {
        return AttachmentMenuController._someFilesAvailable();
      },

      doCommand() {
        HandleAllAttachments("save");
      },
    },

    cmd_detachAllAttachments: {
      isEnabled() {
        return AttachmentMenuController._canDetachFiles();
      },

      doCommand() {
        HandleAllAttachments("detach");
      },
    },

    cmd_deleteAllAttachments: {
      isEnabled() {
        return AttachmentMenuController._canDetachFiles();
      },

      doCommand() {
        HandleAllAttachments("delete");
      },
    },
  },

  _canDetachFiles() {
    let someNotDetached = currentAttachments.some(function(aAttachment) {
      return !aAttachment.isExternalAttachment;
    });

    return (
      CanDetachAttachments() && someNotDetached && this._someFilesAvailable()
    );
  },

  _someFilesAvailable() {
    return currentAttachments.some(function(aAttachment) {
      return aAttachment.hasFile;
    });
  },

  supportsCommand(aCommand) {
    return aCommand in this.commands;
  },

  isCommandEnabled(aCommand) {
    if (!this.supportsCommand(aCommand)) {
      return false;
    }

    return this.commands[aCommand].isEnabled();
  },

  doCommand(aCommand) {
    if (!this.supportsCommand(aCommand)) {
      return;
    }
    let cmd = this.commands[aCommand];
    if (!cmd.isEnabled()) {
      return;
    }
    cmd.doCommand();
  },

  onEvent(aEvent) {},
};

function goUpdateAttachmentCommands() {
  for (let action of ["open", "save", "detach", "delete"]) {
    document.getElementById(
      `context-${action}AllAttachments`
    ).disabled = !AttachmentMenuController.isCommandEnabled(
      `cmd_${action}AllAttachments`
    );
  }
}

async function displayAttachmentsForExpandedView() {
  var bundle = document.getElementById("bundle_messenger");
  var numAttachments = currentAttachments.length;
  var attachmentView = document.getElementById("attachmentView");
  var attachmentSplitter = document.getElementById("attachment-splitter");
  document
    .getElementById("attachmentIcon")
    .setAttribute("src", "chrome://messenger/skin/icons/attach.svg");

  if (numAttachments <= 0) {
    attachmentView.collapsed = true;
    attachmentSplitter.collapsed = true;
  } else if (!gBuildAttachmentsForCurrentMsg) {
    attachmentView.collapsed = false;

    var attachmentList = document.getElementById("attachmentList");

    attachmentList.controllers.appendController(AttachmentListController);

    toggleAttachmentList(false);

    for (let attachment of currentAttachments) {
      // Create a new attachment widget
      var displayName = SanitizeAttachmentDisplayName(attachment);
      var item = attachmentList.appendItem(attachment, displayName);
      item.setAttribute("tooltiptext", attachment.name);
      item.addEventListener("command", attachmentItemCommand);

      // Get a detached file's size. For link attachments, the user must always
      // initiate the fetch for privacy reasons.
      if (attachment.isFileAttachment) {
        await attachment.isEmpty();
      }
    }

    if (
      Services.prefs.getBoolPref("mailnews.attachments.display.start_expanded")
    ) {
      toggleAttachmentList(true);
    }

    let attachmentInfo = document.getElementById("attachmentInfo");
    let attachmentCount = document.getElementById("attachmentCount");
    let attachmentName = document.getElementById("attachmentName");
    let attachmentSize = document.getElementById("attachmentSize");

    if (numAttachments == 1) {
      let count = bundle.getString("attachmentCountSingle");
      let name = SanitizeAttachmentDisplayName(currentAttachments[0]);

      attachmentInfo.setAttribute("contextmenu", "attachmentItemContext");
      attachmentCount.setAttribute("value", count);
      attachmentName.hidden = false;
      attachmentName.setAttribute("value", name);
    } else {
      let words = bundle.getString("attachmentCount");
      let count = PluralForm.get(currentAttachments.length, words).replace(
        "#1",
        currentAttachments.length
      );

      attachmentInfo.setAttribute("contextmenu", "attachmentListContext");
      attachmentCount.setAttribute("value", count);
      attachmentName.hidden = true;
    }

    attachmentSize.value = getAttachmentsTotalSizeStr();

    // Extra candy for external attachments.
    displayAttachmentsForExpandedViewExternal();

    // Show the appropriate toolbar button and label based on the number of
    // attachments.
    updateSaveAllAttachmentsButton();

    gBuildAttachmentsForCurrentMsg = true;
  }
}

function displayAttachmentsForExpandedViewExternal() {
  let bundleMessenger = document.getElementById("bundle_messenger");
  let attachmentName = document.getElementById("attachmentName");
  let attachmentList = document.getElementById("attachmentList");

  // Attachment bar single.
  let firstAttachment = attachmentList.firstElementChild.attachment;
  let isExternalAttachment = firstAttachment.isExternalAttachment;
  let displayUrl = isExternalAttachment ? firstAttachment.displayUrl : "";
  let tooltiptext =
    isExternalAttachment || firstAttachment.isDeleted
      ? ""
      : attachmentName.getAttribute("tooltiptextopen");
  let externalAttachmentNotFound = bundleMessenger.getString(
    "externalAttachmentNotFound"
  );

  attachmentName.textContent = displayUrl;
  attachmentName.tooltipText = tooltiptext;
  attachmentName.setAttribute(
    "tooltiptextexternalnotfound",
    externalAttachmentNotFound
  );
  attachmentName.addEventListener("mouseover", () =>
    top.MsgStatusFeedback.setOverLink(displayUrl)
  );
  attachmentName.addEventListener("mouseout", () =>
    top.MsgStatusFeedback.setOverLink("")
  );
  attachmentName.addEventListener("focus", () =>
    top.MsgStatusFeedback.setOverLink(displayUrl)
  );
  attachmentName.addEventListener("blur", () =>
    top.MsgStatusFeedback.setOverLink("")
  );
  attachmentName.classList.remove("text-link");
  attachmentName.classList.remove("notfound");

  if (firstAttachment.isDeleted) {
    attachmentName.classList.add("notfound");
  }

  if (isExternalAttachment) {
    attachmentName.classList.add("text-link");

    if (!firstAttachment.hasFile) {
      attachmentName.setAttribute("tooltiptext", externalAttachmentNotFound);
      attachmentName.classList.add("notfound");
    }
  }

  // Expanded attachment list.
  let index = 0;
  for (let attachmentitem of attachmentList.children) {
    let attachment = attachmentitem.attachment;
    if (attachment.isDeleted) {
      attachmentitem.classList.add("notfound");
    }

    if (attachment.isExternalAttachment) {
      displayUrl = attachment.displayUrl;
      attachmentitem.setAttribute("tooltiptext", "");
      attachmentitem.addEventListener("mouseover", () =>
        top.MsgStatusFeedback.setOverLink(displayUrl)
      );
      attachmentitem.addEventListener("mouseout", () =>
        top.MsgStatusFeedback.setOverLink("")
      );
      attachmentitem.addEventListener("focus", () =>
        top.MsgStatusFeedback.setOverLink(displayUrl)
      );
      attachmentitem.addEventListener("blur", () =>
        top.MsgStatusFeedback.setOverLink("")
      );

      attachmentitem
        .querySelector(".attachmentcell-name")
        .classList.add("text-link");
      attachmentitem
        .querySelector(".attachmentcell-extension")
        .classList.add("text-link");

      if (attachment.isLinkAttachment) {
        if (index == 0) {
          attachment.size = currentAttachments[index].size;
        }
      }

      if (!attachment.hasFile) {
        attachmentitem.setAttribute("tooltiptext", externalAttachmentNotFound);
        attachmentitem.classList.add("notfound");
      }
    }

    index++;
  }
}

/**
 * Update the "save all attachments" button in the attachment pane, showing
 * the proper button and enabling/disabling it as appropriate.
 */
function updateSaveAllAttachmentsButton() {
  let saveAllSingle = document.getElementById("attachmentSaveAllSingle");
  let saveAllMultiple = document.getElementById("attachmentSaveAllMultiple");

  // If we can't find the buttons, they're not on the toolbar, so bail out!
  if (!saveAllSingle || !saveAllMultiple) {
    return;
  }

  let allDeleted = currentAttachments.every(function(attachment) {
    return !attachment.hasFile;
  });
  let single = currentAttachments.length == 1;

  saveAllSingle.hidden = !single;
  saveAllMultiple.hidden = single;
  saveAllSingle.disabled = saveAllMultiple.disabled = allDeleted;
}

/**
 * Update the attachments display info after a particular attachment's
 * existence has been verified.
 *
 * @param {AttachmentInfo} attachmentInfo
 * @param {boolean} isFetching
 */
function updateAttachmentsDisplay(attachmentInfo, isFetching) {
  if (attachmentInfo.isExternalAttachment) {
    let attachmentList = document.getElementById("attachmentList");
    let attachmentIcon = document.getElementById("attachmentIcon");
    let attachmentName = document.getElementById("attachmentName");
    let attachmentSize = document.getElementById("attachmentSize");
    let attachmentItem = attachmentList.findItemForAttachment(attachmentInfo);
    let index = attachmentList.getIndexOfItem(attachmentItem);

    if (isFetching) {
      // Set elements busy to show the user this is potentially a long network
      // fetch for the link attachment.
      attachmentList.setAttachmentLoaded(attachmentItem, false);
      return;
    }

    if (attachmentInfo.message != gMessage) {
      // The user changed messages while fetching, reset the bar and exit;
      // the listitems are torn down/rebuilt on each message load.
      attachmentIcon.setAttribute(
        "src",
        "chrome://messenger/skin/icons/attach.svg"
      );
      return;
    }

    if (index == -1) {
      // The user changed messages while fetching, then came back to the same
      // message. The reset of busy state has already happened and anyway the
      // item has already been torn down so the index will be invalid; exit.
      return;
    }

    currentAttachments[index].size = attachmentInfo.size;
    let tooltiptextExternalNotFound = attachmentName.getAttribute(
      "tooltiptextexternalnotfound"
    );

    let sizeStr;
    let bundle = document.getElementById("bundle_messenger");
    if (attachmentInfo.size < 1) {
      sizeStr = bundle.getString("attachmentSizeUnknown");
    } else {
      sizeStr = top.messenger.formatFileSize(attachmentInfo.size);
    }

    // The attachment listitem.
    attachmentList.setAttachmentLoaded(attachmentItem, true);
    attachmentList.setAttachmentSize(
      attachmentItem,
      attachmentInfo.hasFile ? sizeStr : ""
    );

    // FIXME: The UI logic for this should be moved to the attachment list or
    // item itself.
    if (attachmentInfo.hasFile) {
      attachmentItem.removeAttribute("tooltiptext");
      attachmentItem.classList.remove("notfound");
    } else {
      attachmentItem.setAttribute("tooltiptext", tooltiptextExternalNotFound);
      attachmentItem.classList.add("notfound");
    }

    // The attachmentbar.
    updateSaveAllAttachmentsButton();
    attachmentSize.value = getAttachmentsTotalSizeStr();
    if (attachmentList.isLoaded()) {
      attachmentIcon.setAttribute(
        "src",
        "chrome://messenger/skin/icons/attach.svg"
      );
    }

    // If it's the first one (and there's only one).
    if (index == 0) {
      if (attachmentInfo.hasFile) {
        attachmentName.removeAttribute("tooltiptext");
        attachmentName.classList.remove("notfound");
      } else {
        attachmentName.setAttribute("tooltiptext", tooltiptextExternalNotFound);
        attachmentName.classList.add("notfound");
      }
    }

    // Reset widths since size may have changed; ensure no false cropping of
    // the attachment item name.
    attachmentList.setOptimumWidth();
  }
}

/**
 * Calculate the total size of all attachments in the message as emitted to
 * |currentAttachments| and return a pretty string.
 *
 * @returns {string} - Description of the attachment size (e.g. 123 KB or 3.1MB)
 */
function getAttachmentsTotalSizeStr() {
  let bundle = document.getElementById("bundle_messenger");
  let totalSize = 0;
  let lastPartID;
  let unknownSize = false;
  for (let attachment of currentAttachments) {
    // Check if this attachment's part ID is a child of the last attachment
    // we counted. If so, skip it, since we already accounted for its size
    // from its parent.
    if (!lastPartID || attachment.partID.indexOf(lastPartID) != 0) {
      lastPartID = attachment.partID;
      if (attachment.size != -1) {
        totalSize += Number(attachment.size);
      } else if (!attachment.isDeleted) {
        unknownSize = true;
      }
    }
  }

  let sizeStr = top.messenger.formatFileSize(totalSize);
  if (unknownSize) {
    if (totalSize == 0) {
      sizeStr = bundle.getString("attachmentSizeUnknown");
    } else {
      sizeStr = bundle.getFormattedString("attachmentSizeAtLeast", [sizeStr]);
    }
  }

  return sizeStr;
}

/**
 * Expand/collapse the attachment list. When expanding it, automatically resize
 * it to an appropriate height (1/4 the message pane or smaller).
 *
 * @param expanded  True if the attachment list should be expanded, false
 *                  otherwise. If |expanded| is not specified, toggle the state.
 * @param updateFocus  (optional) True if the focus should be updated, focusing
 *                     on the attachmentList when expanding, or the messagepane
 *                     when collapsing (but only when the attachmentList was
 *                     originally focused).
 */
function toggleAttachmentList(expanded, updateFocus) {
  var attachmentView = document.getElementById("attachmentView");
  var attachmentBar = document.getElementById("attachmentBar");
  var attachmentToggle = document.getElementById("attachmentToggle");
  var attachmentList = document.getElementById("attachmentList");
  var attachmentSplitter = document.getElementById("attachment-splitter");
  var bundle = document.getElementById("bundle_messenger");

  if (expanded === undefined) {
    expanded = !attachmentToggle.checked;
  }

  attachmentToggle.checked = expanded;

  if (expanded) {
    attachmentList.collapsed = false;
    if (!attachmentView.collapsed) {
      attachmentSplitter.collapsed = false;
    }
    attachmentBar.setAttribute(
      "tooltiptext",
      bundle.getString("collapseAttachmentPaneTooltip")
    );

    attachmentList.setOptimumWidth();

    // By design, attachmentView should not take up more than 1/4 of the message
    // pane space
    attachmentView.setAttribute(
      "height",
      Math.min(
        attachmentList.preferredHeight,
        document.getElementById("messagepanebox").getBoundingClientRect()
          .height / 4
      )
    );

    if (updateFocus) {
      attachmentList.focus();
    }
  } else {
    attachmentList.collapsed = true;
    attachmentSplitter.collapsed = true;
    attachmentBar.setAttribute(
      "tooltiptext",
      bundle.getString("expandAttachmentPaneTooltip")
    );
    attachmentView.removeAttribute("height");

    if (updateFocus && document.activeElement == attachmentList) {
      // TODO
    }
  }
}

/**
 * Pick out a nice icon for the attachment.
 *
 * @param attachment  the nsIMsgAttachment object to show icon for
 */
function getIconForAttachment(attachment) {
  if (attachment.isDeleted) {
    return "chrome://messenger/skin/icons/attachment-deleted.svg";
  }
  return `moz-icon://${attachment.name}?size=16&amp;contentType=${attachment.contentType}`;
}

/**
 * Public method called when we create the attachments file menu
 */
function FillAttachmentListPopup(aEvent, aPopup) {
  // First clear out the old view...
  ClearAttachmentMenu(aPopup);

  for (let [attachmentIndex, attachment] of currentAttachments.entries()) {
    addAttachmentToPopup(aPopup, attachment, attachmentIndex);
  }

  goUpdateAttachmentCommands();
}

// Public method used to clear the file attachment menu
function ClearAttachmentMenu(popup) {
  if (popup) {
    while (popup.firstElementChild.localName == "menu") {
      popup.firstElementChild.remove();
    }
  }
}

/**
 * Create a menu for a single attachment.
 *
 * @param popup  the popup to add the menu to
 * @param attachment  the AttachmentInfo object to add
 * @param attachmentIndex  the index (starting at 0) of this attachment
 */
function addAttachmentToPopup(popup, attachment, attachmentIndex) {
  if (!popup) {
    return;
  }

  var item = document.createXULElement("menu");
  if (!item) {
    return;
  }

  function getString(aName) {
    return document.getElementById("bundle_messenger").getString(aName);
  }

  // Insert the item just before the separator. The separator is the 2nd to
  // last element in the popup.
  item.setAttribute("class", "menu-iconic");
  item.setAttribute("image", getIconForAttachment(attachment));

  // find the separator
  var indexOfSeparator = 0;
  while (popup.children[indexOfSeparator].localName != "menuseparator") {
    indexOfSeparator++;
  }
  // We increment the attachmentIndex here since we only use it for the
  // label and accesskey attributes, and we want the accesskeys for the
  // attachments list in the menu to be 1-indexed.
  attachmentIndex++;
  var displayName = SanitizeAttachmentDisplayName(attachment);
  var label = document
    .getElementById("bundle_messenger")
    .getFormattedString("attachmentDisplayNameFormat", [
      attachmentIndex,
      displayName,
    ]);
  item.setAttribute("crop", "center");
  item.setAttribute("label", label);
  item.setAttribute("accesskey", attachmentIndex % 10);

  // Each attachment in the list gets its own menupopup with options for
  // saving, deleting, detaching, etc.
  var openpopup = document.createXULElement("menupopup");
  openpopup = item.appendChild(openpopup);
  openpopup.addEventListener("popupshowing", function(aEvent) {
    aEvent.stopPropagation();
  });

  // Due to Bug #314228, we must append our menupopup to the new attachment
  // menu item before we inserting the attachment menu into the popup. If we
  // don't, our attachment menu items will not show up.
  item = popup.insertBefore(item, popup.children[indexOfSeparator]);

  if (attachment.isExternalAttachment) {
    if (!attachment.hasFile) {
      item.classList.add("notfound");
    } else {
      // The text-link class must be added to the <label> and have a <menu>
      // hover rule. Adding to <menu> makes hover overflow the underline to
      // the popup items.
      let label = item.children[1];
      label.classList.add("text-link");
    }
  }

  if (attachment.isDeleted) {
    item.classList.add("notfound");
  }

  var detached = attachment.isExternalAttachment;
  var deleted = !attachment.hasFile;
  var canDetach = CanDetachAttachments() && !deleted && !detached;

  if (deleted) {
    // We can't do anything with a deleted attachment, so just return.
    item.disabled = true;
    return;
  }

  // Create the "open" menu item
  var menuitementry = document.createXULElement("menuitem");
  menuitementry.attachment = attachment;
  menuitementry.setAttribute("oncommand", "this.attachment.open();");
  menuitementry.setAttribute("label", getString("openLabel"));
  menuitementry.setAttribute("accesskey", getString("openLabelAccesskey"));
  menuitementry.setAttribute("disabled", deleted);
  menuitementry = openpopup.appendChild(menuitementry);

  // Create a menuseparator
  var menuseparator = document.createXULElement("menuseparator");
  openpopup.appendChild(menuseparator);

  // Create the "save" menu item
  menuitementry = document.createXULElement("menuitem");
  menuitementry.attachment = attachment;
  menuitementry.setAttribute("oncommand", "this.attachment.save();");
  menuitementry.setAttribute("label", getString("saveLabel"));
  menuitementry.setAttribute("accesskey", getString("saveLabelAccesskey"));
  menuitementry.setAttribute("disabled", deleted);
  menuitementry = openpopup.appendChild(menuitementry);

  // Create the "detach" menu item
  menuitementry = document.createXULElement("menuitem");
  menuitementry.attachment = attachment;
  menuitementry.setAttribute("oncommand", "this.attachment.detach(true);");
  menuitementry.setAttribute("label", getString("detachLabel"));
  menuitementry.setAttribute("accesskey", getString("detachLabelAccesskey"));
  menuitementry.setAttribute("disabled", !canDetach);
  menuitementry = openpopup.appendChild(menuitementry);

  // Create the "delete" menu item
  menuitementry = document.createXULElement("menuitem");
  menuitementry.attachment = attachment;
  menuitementry.setAttribute("oncommand", "this.attachment.detach(false);");
  menuitementry.setAttribute("label", getString("deleteLabel"));
  menuitementry.setAttribute("accesskey", getString("deleteLabelAccesskey"));
  menuitementry.setAttribute("disabled", !canDetach);
  menuitementry = openpopup.appendChild(menuitementry);

  // Create the "open containing folder" menu item, for existing detached only.
  if (attachment.isFileAttachment) {
    let menuseparator = document.createXULElement("menuseparator");
    openpopup.appendChild(menuseparator);
    menuitementry = document.createXULElement("menuitem");
    menuitementry.attachment = attachment;
    menuitementry.setAttribute("oncommand", "this.attachment.openFolder();");
    menuitementry.setAttribute("label", getString("openFolderLabel"));
    menuitementry.setAttribute(
      "accesskey",
      getString("openFolderLabelAccesskey")
    );
    menuitementry.setAttribute("disabled", !attachment.hasFile);
    menuitementry = openpopup.appendChild(menuitementry);
  }
}

/**
 * Open an attachment from the attachment bar.
 *
 * @param event the event that triggered this action
 */
function OpenAttachmentFromBar(event) {
  if (event.button == 0) {
    // Only open on the first click; ignore double-clicks so that the user
    // doesn't end up with the attachment opened multiple times.
    if (event.detail == 1) {
      TryHandleAllAttachments("open");
    }
    event.stopPropagation();
  }
}

/**
 * Handle all the attachments in this message (save them, open them, etc).
 *
 * @param action one of "open", "save", "saveAs", "detach", or "delete"
 */
function HandleAllAttachments(action) {
  HandleMultipleAttachments(currentAttachments, action);
}

/**
 * Try to handle all the attachments in this message (save them, open them,
 * etc). If the action fails for whatever reason, catch the error and report it.
 *
 * @param action  one of "open", "save", "saveAs", "detach", or "delete"
 */
function TryHandleAllAttachments(action) {
  try {
    HandleAllAttachments(action);
  } catch (e) {
    console.error(e);
  }
}

/**
 * Handle the currently-selected attachments in this message (save them, open
 * them, etc).
 *
 * @param action  one of "open", "save", "saveAs", "detach", or "delete"
 */
function HandleSelectedAttachments(action) {
  let attachmentList = document.getElementById("attachmentList");
  let selectedAttachments = [];
  for (let item of attachmentList.selectedItems) {
    selectedAttachments.push(item.attachment);
  }

  HandleMultipleAttachments(selectedAttachments, action);
}

/**
 * Perform an action on multiple attachments (e.g. open or save)
 *
 * @param attachments  an array of AttachmentInfo objects to work with
 * @param action  one of "open", "save", "saveAs", "detach", or "delete"
 */
function HandleMultipleAttachments(attachments, action) {
  // Feed message link attachments save handling.
  if (
    FeedUtils.isFeedMessage(gMessage) &&
    (action == "save" || action == "saveAs")
  ) {
    saveLinkAttachmentsToFile(attachments);
    return;
  }

  // convert our attachment data into some c++ friendly structs
  var attachmentContentTypeArray = [];
  var attachmentUrlArray = [];
  var attachmentDisplayUrlArray = [];
  var attachmentDisplayNameArray = [];
  var attachmentMessageUriArray = [];

  // populate these arrays..
  var actionIndex = 0;
  for (let attachment of attachments) {
    // Exclude attachment which are 1) deleted, or 2) detached with missing
    // external files, unless copying urls.
    if (!attachment.hasFile && action != "copyUrl") {
      continue;
    }

    attachmentContentTypeArray[actionIndex] = attachment.contentType;
    attachmentUrlArray[actionIndex] = attachment.url;
    attachmentDisplayUrlArray[actionIndex] = attachment.displayUrl;
    attachmentDisplayNameArray[actionIndex] = encodeURI(attachment.name);
    attachmentMessageUriArray[actionIndex] = attachment.uri;
    ++actionIndex;
  }

  // The list has been built. Now call our action code...
  switch (action) {
    case "save":
      top.messenger.saveAllAttachments(
        attachmentContentTypeArray,
        attachmentUrlArray,
        attachmentDisplayNameArray,
        attachmentMessageUriArray
      );
      return;
    case "detach":
      // "detach" on a multiple selection of attachments is so far not really
      // supported. As a workaround, resort to normal detach-"all". See also
      // the comment on 'detaching a multiple selection of attachments' below.
      if (attachments.length == 1) {
        attachments[0].detach(true);
      } else {
        top.messenger.detachAllAttachments(
          attachmentContentTypeArray,
          attachmentUrlArray,
          attachmentDisplayNameArray,
          attachmentMessageUriArray,
          true // save
        );
      }
      return;
    case "delete":
      top.messenger.detachAllAttachments(
        attachmentContentTypeArray,
        attachmentUrlArray,
        attachmentDisplayNameArray,
        attachmentMessageUriArray,
        false // don't save
      );
      return;
    case "open":
      // XXX hack alert. If we sit in tight loop and open multiple
      // attachments, we get chrome errors in layout as we start loading the
      // first helper app dialog then before it loads, we kick off the next
      // one and the next one. Subsequent helper app dialogs were failing
      // because we were still loading the chrome files for the first attempt
      // (error about the xul cache being empty). For now, work around this by
      // doing the first helper app dialog right away, then waiting a bit
      // before we launch the rest.
      let actionFunction = function(aAttachment) {
        aAttachment.open();
      };

      for (let i = 0; i < attachments.length; i++) {
        if (i == 0) {
          actionFunction(attachments[i]);
        } else {
          setTimeout(actionFunction, 100, attachments[i]);
        }
      }
      return;
    case "saveAs":
      // Show one save dialog at a time, which allows to adjust the file name
      // and folder path for each attachment. For added convenience, we remember
      // the folder path of each file for the save dialog of the next one.
      let saveAttachments = function(attachments) {
        if (attachments.length > 0) {
          attachments[0].save().then(function() {
            saveAttachments(attachments.slice(1));
          });
        }
      };

      saveAttachments(attachments);
      return;
    case "copyUrl":
      // Copy external http url(s) to clipboard. The menuitem is hidden unless
      // all selected attachment urls are http.
      navigator.clipboard.writeText(attachmentDisplayUrlArray.join("\n"));
      return;
    case "openFolder":
      for (let attachment of attachments) {
        setTimeout(() => attachment.openFolder());
      }
      return;
    default:
      throw new Error("unknown HandleMultipleAttachments action: " + action);
  }
}

/**
 * Link attachments are passed as an array of AttachmentInfo objects. This
 * is meant to download http link content using the browser method.
 *
 * @param {AttachmentInfo[]} aAttachmentInfoArray - Array of attachmentInfo.
 */
async function saveLinkAttachmentsToFile(aAttachmentInfoArray) {
  for (let attachment of aAttachmentInfoArray) {
    if (!attachment.hasFile || attachment.message != gMessage) {
      continue;
    }

    let empty = await attachment.isEmpty();
    if (empty) {
      continue;
    }

    // internalSave() is part of saveURL() internals...
    internalSave(
      attachment.url, // aURL,
      null, // aOriginalUrl,
      undefined, // aDocument,
      attachment.name, // aDefaultFileName,
      undefined, // aContentDisposition,
      undefined, // aContentType,
      undefined, // aShouldBypassCache,
      undefined, // aFilePickerTitleKey,
      undefined, // aChosenData,
      undefined, // aReferrer,
      undefined, // aCookieJarSettings,
      document, // aInitiatingDocument,
      undefined, // aSkipPrompt,
      undefined, // aCacheKey,
      undefined // aIsContentWindowPrivate
    );
  }
}

function ClearAttachmentList() {
  // clear selection
  var list = document.getElementById("attachmentList");
  list.clearSelection();

  while (list.hasChildNodes()) {
    list.lastChild.remove();
  }
}

// See attachmentBucketDNDObserver, which should have the same logic.
let attachmentListDNDObserver = {
  onDragStart(event) {
    // NOTE: Starting a drag on an attachment item will normally also select
    // the attachment item before this method is called. But this is not
    // necessarily the case. E.g. holding Shift when starting the drag
    // operation. When it isn't selected, we just don't transfer.
    if (event.target.matches(".attachmentItem[selected]")) {
      // Also transfer other selected attachment items.
      let attachments = Array.from(
        document.querySelectorAll("#attachmentList .attachmentItem[selected]"),
        item => item.attachment
      );
      setupDataTransfer(event, attachments);
    }
    event.stopPropagation();
  },
};

let attachmentNameDNDObserver = {
  onDragStart(event) {
    let attachmentList = document.getElementById("attachmentList");
    setupDataTransfer(event, [attachmentList.getItemAtIndex(0).attachment]);
    event.stopPropagation();
  },
};

function onShowOtherActionsPopup() {
  // Enable/disable the Open Conversation button.
  let glodaEnabled = Services.prefs.getBoolPref(
    "mailnews.database.global.indexer.enabled"
  );

  let openConversation = document.getElementById(
    "otherActionsOpenConversation"
  );
  // Check because this menuitem element is not present in messageWindow.xhtml.
  if (openConversation) {
    openConversation.disabled = !(
      glodaEnabled && Gloda.isMessageIndexed(gMessage)
    );
  }

  if (SelectedMessagesAreRead()) {
    document.getElementById("markAsReadMenuItem").setAttribute("hidden", true);
    document.getElementById("markAsUnreadMenuItem").removeAttribute("hidden");
  } else {
    document.getElementById("markAsReadMenuItem").removeAttribute("hidden");
    document
      .getElementById("markAsUnreadMenuItem")
      .setAttribute("hidden", true);
  }

  // Check if the current message is feed or not.
  let isFeed = FeedUtils.isFeedMessage(gMessage);
  document.getElementById("otherActionsMessageBodyAs").hidden = isFeed;
  document.getElementById("otherActionsFeedBodyAs").hidden = !isFeed;
}

function InitOtherActionsViewBodyMenu() {
  let html_as = Services.prefs.getIntPref("mailnews.display.html_as");
  let prefer_plaintext = Services.prefs.getBoolPref(
    "mailnews.display.prefer_plaintext"
  );
  let disallow_classes = Services.prefs.getIntPref(
    "mailnews.display.disallow_mime_handlers"
  );
  let isFeed = false; // TODO
  const kDefaultIDs = [
    "otherActionsMenu_bodyAllowHTML",
    "otherActionsMenu_bodySanitized",
    "otherActionsMenu_bodyAsPlaintext",
    "otherActionsMenu_bodyAllParts",
  ];
  const kRssIDs = [
    "otherActionsMenu_bodyFeedSummaryAllowHTML",
    "otherActionsMenu_bodyFeedSummarySanitized",
    "otherActionsMenu_bodyFeedSummaryAsPlaintext",
  ];
  let menuIDs = isFeed ? kRssIDs : kDefaultIDs;

  if (disallow_classes > 0) {
    window.top.gDisallow_classes_no_html = disallow_classes;
  }
  // else gDisallow_classes_no_html keeps its initial value (see top)

  let AllowHTML_menuitem = document.getElementById(menuIDs[0]);
  let Sanitized_menuitem = document.getElementById(menuIDs[1]);
  let AsPlaintext_menuitem = document.getElementById(menuIDs[2]);
  let AllBodyParts_menuitem = menuIDs[3]
    ? document.getElementById(menuIDs[3])
    : null;

  document.getElementById(
    "otherActionsMenu_bodyAllParts"
  ).hidden = !Services.prefs.getBoolPref(
    "mailnews.display.show_all_body_parts_menu"
  );

  // Clear all checkmarks.
  AllowHTML_menuitem.removeAttribute("checked");
  Sanitized_menuitem.removeAttribute("checked");
  AsPlaintext_menuitem.removeAttribute("checked");
  if (AllBodyParts_menuitem) {
    AllBodyParts_menuitem.removeAttribute("checked");
  }

  if (
    !prefer_plaintext &&
    !html_as &&
    !disallow_classes &&
    AllowHTML_menuitem
  ) {
    AllowHTML_menuitem.setAttribute("checked", true);
  } else if (
    !prefer_plaintext &&
    html_as == 3 &&
    disallow_classes > 0 &&
    Sanitized_menuitem
  ) {
    Sanitized_menuitem.setAttribute("checked", true);
  } else if (
    prefer_plaintext &&
    html_as == 1 &&
    disallow_classes > 0 &&
    AsPlaintext_menuitem
  ) {
    AsPlaintext_menuitem.setAttribute("checked", true);
  } else if (
    !prefer_plaintext &&
    html_as == 4 &&
    !disallow_classes &&
    AllBodyParts_menuitem
  ) {
    AllBodyParts_menuitem.setAttribute("checked", true);
  }
  // else (the user edited prefs/user.js) check none of the radio menu items

  if (isFeed) {
    AllowHTML_menuitem.hidden = !gShowFeedSummary;
    Sanitized_menuitem.hidden = !gShowFeedSummary;
    AsPlaintext_menuitem.hidden = !gShowFeedSummary;
    document.getElementById(
      "otherActionsMenu_viewFeedSummarySeparator"
    ).hidden = !gShowFeedSummary;
  }
}

/**
 * Object literal to handle a few simple customization options for the message
 * header.
 */
const gHeaderCustomize = {
  docURL: "chrome://messenger/content/messenger.xhtml",
  /**
   * The DOM element panel collecting all customization options.
   *
   * @type {XULElement}
   */
  customizePanel: null,
  /**
   * The object storing all saved customization options.
   *
   * @type {object}
   * @property {boolean} showAvatar - If the profile picutre of the sender
   *   should be showed.
   * @property {boolean} showFullAddress - If the sender recipient should always
   *   show the full name and email address.
   * @property {boolean} hideLabels - If the labels column should be hidden.
   * @property {boolean} subjectLarge - If the font size of the subject line
   *   should be increased.
   * @property {string} buttonStyle - The style in which the buttons should be
   *   rendered:
   *   - "default" = icons+text
   *   - "only-icons" = only icons
   *   - "only-text" = only text
   */
  customizeData: {
    showAvatar: false,
    showFullAddress: false,
    hideLabels: false,
    subjectLarge: false,
    buttonStyle: "default",
  },

  /**
   * Initialize the customizer.
   */
  init() {
    this.customizePanel = document.getElementById(
      "messageHeaderCustomizationPanel"
    );

    let xulStore = Services.xulStore;
    if (xulStore.hasValue(this.docURL, "messageHeader", "layout")) {
      this.customizeData = JSON.parse(
        xulStore.getValue(this.docURL, "messageHeader", "layout")
      );
      this.updateLayout();
    }
  },

  /**
   * Reset and update the customized style of the message header.
   */
  updateLayout() {
    let header = document.getElementById("messageHeader");
    // Always clear existing styles to avoid visual issues.
    header.classList.remove(
      "message-header-large-subject",
      "message-header-buttons-only-icons",
      "message-header-buttons-only-text",
      "message-header-hide-label-column"
    );

    // Bail out if we don't have anything to customize.
    if (!Object.keys(this.customizeData).length) {
      return;
    }

    header.classList.toggle(
      "message-header-large-subject",
      this.customizeData.subjectLarge || false
    );

    header.classList.toggle(
      "message-header-hide-label-column",
      this.customizeData.hideLabels || false
    );

    header.classList.toggle(
      "message-header-show-recipient-avatar",
      this.customizeData.showAvatar || false
    );

    header.classList.toggle(
      "message-header-show-sender-full-address",
      this.customizeData.showFullAddress || false
    );

    switch (this.customizeData.buttonStyle) {
      case "only-icons":
      case "only-text":
        header.classList.add(
          `message-header-buttons-${this.customizeData.buttonStyle}`
        );
        break;

      case "default":
      default:
        header.classList.remove(
          "message-header-buttons-only-icons",
          "message-header-buttons-only-text"
        );
        break;
    }

    gMessageHeader.syncLabelsColumnWidths();
  },

  /**
   * Show the customization panel for the message header.
   */
  showPanel() {
    this.customizePanel.openPopup(
      document.getElementById("otherActionsButton"),
      "after_end",
      6,
      6,
      false
    );
  },

  /**
   * Update the panel's elements to reflect the users' customization.
   */
  onPanelShowing() {
    document.getElementById("headerButtonStyle").value =
      this.customizeData.buttonStyle || "default";

    document.getElementById("headerShowAvatar").checked =
      this.customizeData.showAvatar || false;

    document.getElementById("headerShowFullAddress").checked =
      this.customizeData.showFullAddress || false;

    document.getElementById("headerHideLabels").checked =
      this.customizeData.hideLabels || false;

    document.getElementById("headerSubjectLarge").checked =
      this.customizeData.subjectLarge || false;

    let type = Ci.nsMimeHeaderDisplayTypes;
    let pref = Services.prefs.getIntPref("mail.show_headers");

    document.getElementById("headerViewAllHeaders").checked =
      type.AllHeaders == pref;
  },

  /**
   * Update the buttons style when the menuitem value is changed.
   *
   * @param {Event} event - The menuitem command event.
   */
  updateButtonStyle(event) {
    this.customizeData.buttonStyle = event.target.value;
    this.updateLayout();
  },

  /**
   * Show or hide the profile picture of the sender recipient.
   *
   * @param {Event} event - The checkbox command event.
   */
  toggleAvatar(event) {
    this.customizeData.showAvatar = event.target.checked;
    this.updateLayout();
  },

  /**
   * Show or hide the sender's full address, which will show the display name
   * and the email address on two different lines.
   *
   * @param {Event} event - The checkbox command event.
   */
  toggleSenderAddress(event) {
    this.customizeData.showFullAddress = event.target.checked;
    this.updateLayout();
  },

  /**
   * Show or hide the labels column.
   *
   * @param {Event} event - The checkbox command event.
   */
  toggleLabelColumn(event) {
    this.customizeData.hideLabels = event.target.checked;
    this.updateLayout();
  },

  /**
   * Update the subject style when the checkbox is clicked.
   *
   * @param {Event} event - The checkbox command event.
   */
  updateSubjectStyle(event) {
    this.customizeData.subjectLarge = event.target.checked;
    this.updateLayout();
  },

  /**
   * Show or hide all the headers of a message.
   *
   * @param {Event} event - The checkbox command event.
   */
  toggleAllHeaders(event) {
    let mode = event.target.checked
      ? Ci.nsMimeHeaderDisplayTypes.AllHeaders
      : Ci.nsMimeHeaderDisplayTypes.NormalHeaders;
    Services.prefs.setIntPref("mail.show_headers", mode);
    AdjustHeaderView(mode);
    ReloadMessage();
  },

  /**
   * Close the customize panel.
   */
  closePanel() {
    this.customizePanel.hidePopup();
  },

  /**
   * Update the xulStore only when the panel is closed.
   */
  onPanelHidden() {
    Services.xulStore.setValue(
      this.docURL,
      "messageHeader",
      "layout",
      JSON.stringify(this.customizeData)
    );
  },
};

/**
 * Object to handle the creation, destruction, and update of all recipient
 * fields that will be showed in the message header.
 */
const gMessageHeader = {
  /**
   * Get the newsgroup server corresponding to the currently selected message.
   *
   * @returns {?nsISubscribableServer} The server for the newsgroup, or null.
   */
  get newsgroupServer() {
    if (gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false)) {
      return gFolder.server?.QueryInterface(Ci.nsISubscribableServer);
    }

    return null;
  },

  /**
   * Toggle the scrollable style of the message header area.
   *
   * @param {boolean} showAllHeaders - True if we need to show all header fields
   *   and ignore the space limit for multi recipients row.
   */
  toggleScrollableHeader(showAllHeaders) {
    document
      .getElementById("messageHeader")
      .classList.toggle("scrollable", showAllHeaders);
  },

  /**
   * Ensure that the all visible labels have the same size.
   */
  syncLabelsColumnWidths() {
    let allHeaderLabels = document.querySelectorAll(
      ".message-header-row:not([hidden]) .message-header-label"
    );

    // Clear existing style.
    for (let label of allHeaderLabels) {
      label.style.minWidth = null;
    }

    let minWidth = Math.max(...Array.from(allHeaderLabels, i => i.clientWidth));
    for (let label of allHeaderLabels) {
      label.style.minWidth = `${minWidth}px`;
    }
  },

  openCopyPopup(event, element) {
    document.getElementById("copyCreateFilterFrom").disabled = !gFolder?.server
      .canHaveFilters;

    let popup = document.getElementById(
      element.matches(`:scope[is="url-header-row"]`)
        ? "copyUrlPopup"
        : "copyPopup"
    );
    popup.headerField = element;
    popup.openPopupAtScreen(event.screenX, event.screenY, true);
  },

  async openEmailAddressPopup(event, element) {
    // Bail out if we don't have an email address.
    if (!element.emailAddress) {
      return;
    }

    document
      .getElementById("emailAddressPlaceHolder")
      .setAttribute("label", element.emailAddress);

    document.getElementById("addToAddressBookItem").hidden =
      element.cardDetails.card;
    document.getElementById("editContactItem").hidden =
      !element.cardDetails.card || element.cardDetails.book?.readOnly;
    document.getElementById("viewContactItem").hidden =
      !element.cardDetails.card || !element.cardDetails.book?.readOnly;

    let discoverKeyMenuItem = document.getElementById("searchKeysOpenPGP");
    if (discoverKeyMenuItem) {
      let hidden = await PgpSqliteDb2.hasAnyPositivelyAcceptedKeyForEmail(
        element.emailAddress
      );
      discoverKeyMenuItem.hidden = hidden;
      discoverKeyMenuItem.nextElementSibling.hidden = hidden; // Hide separator.
    }

    document.getElementById("createFilterFrom").disabled = !gFolder?.server
      .canHaveFilters;

    let popup = document.getElementById("emailAddressPopup");
    popup.headerField = element;

    if (!event.screenX) {
      popup.openPopup(event.target, "after_start", 0, 0, true);
      return;
    }

    popup.openPopupAtScreen(event.screenX, event.screenY, true);
  },

  openNewsgroupPopup(event, element) {
    document
      .getElementById("newsgroupPlaceHolder")
      .setAttribute("label", element.textContent);

    let subscribed = this.newsgroupServer
      ?.QueryInterface(Ci.nsINntpIncomingServer)
      .containsNewsgroup(element.textContent);
    document.getElementById("subscribeToNewsgroupItem").hidden = subscribed;
    document.getElementById(
      "subscribeToNewsgroupSeparator"
    ).hidden = subscribed;

    let popup = document.getElementById("newsgroupPopup");
    popup.headerField = element;

    if (!event.screenX) {
      popup.openPopup(event.target, "after_start", 0, 0, true);
      return;
    }

    popup.openPopupAtScreen(event.screenX, event.screenY, true);
  },

  openMessageIdPopup(event, element) {
    document
      .getElementById("messageIdContext-messageIdTarget")
      .setAttribute("label", element.id);

    // We don't want to show "Open Message For ID" for the same message
    // we're viewing.
    document.getElementById("messageIdContext-openMessageForMsgId").hidden =
      `<${gMessage.messageId}>` == element.id;

    // We don't want to show "Open Browser With Message-ID" for non-nntp
    // messages.
    document.getElementById(
      "messageIdContext-openBrowserWithMsgId"
    ).hidden = !gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false);

    let popup = document.getElementById("messageIdContext");
    popup.headerField = element;

    if (!event.screenX) {
      popup.openPopup(event.target, "after_start", 0, 0, true);
      return;
    }

    popup.openPopupAtScreen(event.screenX, event.screenY, true);
  },

  /**
   * Add a contact to the address book.
   *
   * @param {Event} event - The DOM Event.
   */
  addContact(event) {
    event.currentTarget.parentNode.headerField.addToAddressBook();
  },

  /**
   * Show the edit card popup panel.
   *
   * @param {Event} event - The DOM Event.
   */
  showContactEdit(event) {
    this.editContact(event.currentTarget.parentNode.headerField);
  },

  /**
   * Trigger a new message compose window.
   *
   * @param {Event} event - The click DOMEvent.
   */
  composeMessage(event) {
    let recipient = event.currentTarget.parentNode.headerField;

    let fields = Cc[
      "@mozilla.org/messengercompose/composefields;1"
    ].createInstance(Ci.nsIMsgCompFields);

    if (recipient.classList.contains("header-newsgroup")) {
      fields.newsgroups = recipient.textContent;
    }

    if (recipient.fullAddress) {
      let addresses = MailServices.headerParser.makeFromDisplayAddress(
        recipient.fullAddress
      );
      if (addresses.length) {
        fields.to = MailServices.headerParser.makeMimeHeader([addresses[0]]);
      }
    }

    let params = Cc[
      "@mozilla.org/messengercompose/composeparams;1"
    ].createInstance(Ci.nsIMsgComposeParams);
    params.type = Ci.nsIMsgCompType.New;

    // If the Shift key was pressed toggle the composition format
    // (HTML vs. plaintext).
    params.format = event.shiftKey
      ? Ci.nsIMsgCompFormat.OppositeOfDefault
      : Ci.nsIMsgCompFormat.Default;

    if (gFolder) {
      params.identity = MailServices.accounts.getFirstIdentityForServer(
        gFolder.server
      );
    }
    params.composeFields = fields;
    MailServices.compose.OpenComposeWindowWithParams(null, params);
  },

  /**
   * Copy the email address, as well as the name if wanted, in the clipboard.
   *
   * @param {Event} event - The DOM Event.
   * @param {boolean} withName - True if we need to copy also the name.
   */
  copyAddress(event, withName = false) {
    let recipient = event.currentTarget.parentNode.headerField;
    let address;
    if (recipient.classList.contains("header-newsgroup")) {
      address = recipient.textContent;
    } else {
      address = withName ? recipient.fullAddress : recipient.emailAddress;
    }
    navigator.clipboard.writeText(address);
  },

  copyNewsgroupURL(event) {
    let server = this.newsgroupServer;
    if (!server) {
      return;
    }

    let newsgroup = event.currentTarget.parentNode.headerField.textContent;

    let url;
    if (server.socketType != Ci.nsMsgSocketType.SSL) {
      url = "news://" + server.hostName;
      if (server.port != Ci.nsINntpUrl.DEFAULT_NNTP_PORT) {
        url += ":" + server.port;
      }
      url += "/" + newsgroup;
    } else {
      url = "snews://" + server.hostName;
      if (server.port != Ci.nsINntpUrl.DEFAULT_NNTPS_PORT) {
        url += ":" + server.port;
      }
      url += "/" + newsgroup;
    }

    try {
      let uri = Services.io.newURI(url);
      navigator.clipboard.writeText(decodeURI(uri.spec));
    } catch (e) {
      console.error("Invalid URL: " + url);
    }
  },

  /**
   * Subscribe to a newsgroup.
   *
   * @param {Event} event - The DOM Event.
   */
  subscribeToNewsgroup(event) {
    let server = this.newsgroupServer;
    if (server) {
      let newsgroup = event.currentTarget.parentNode.headerField.textContent;
      server.subscribe(newsgroup);
      server.commitSubscribeChanges();
    }
  },

  /**
   * Copy the text value of an header field.
   *
   * @param {Event} event - The DOM Event.
   */
  copyString(event) {
    // This method is used inside the copyPopup menupopup, which is triggered by
    // both HTML headers fields and XUL labels. We need to account for those
    // different widgets in order to properly copy the text.
    let target =
      event.currentTarget.parentNode.triggerNode ||
      event.currentTarget.parentNode.headerField;
    navigator.clipboard.writeText(
      window.getSelection().isCollapsed
        ? target.textContent
        : window.getSelection().toString()
    );
  },

  /**
   * Open the message filter dialog prefilled with available data.
   *
   * @param {Event} event - The DOM Event.
   */
  createFilter(event) {
    let element = event.currentTarget.parentNode.headerField;
    top.MsgFilters(
      element.emailAddress || element.value.textContent,
      gFolder,
      element.dataset.headerName
    );
  },

  /**
   * Show the edit contact popup panel.
   *
   * @param {HTMLLIElement} element - The recipient element.
   */
  editContact(element) {
    editContactInlineUI.showEditContactPanel(element.cardDetails, element);
  },

  /**
   * Set the tags to the message header tag element.
   */
  setTags() {
    // Bail out if we don't have a message selected.
    if (!gMessage || !gFolder) {
      return;
    }

    // Extract the tag keys from the message header.
    let msgKeyArray = gMessage.getStringProperty("keywords").split(" ");

    // Get the list of known tags.
    let tagsArray = MailServices.tags.getAllTags().filter(t => t.tag);
    let tagKeys = {};
    for (let tagInfo of tagsArray) {
      tagKeys[tagInfo.key] = true;
    }
    // Only use tags that match our saved tags.
    let msgKeys = msgKeyArray.filter(k => k in tagKeys);

    if (msgKeys.length) {
      currentHeaderData.tags = {
        headerName: "tags",
        headerValue: msgKeys.join(" "),
      };
      return;
    }

    // No more tags, so clear out the header field.
    delete currentHeaderData.tags;
  },

  onMessageIdClick(event) {
    let id = event.currentTarget.closest(".header-message-id").id;
    if (event.button == 0) {
      // Remove the < and > symbols.
      window.browsingContext.topChromeWindow.OpenMessageForMessageId(
        id.substring(1, id.length - 1)
      );
    }
  },

  openMessage(event) {
    let id = event.currentTarget.parentNode.headerField.id;
    // Remove the < and > symbols.
    window.browsingContext.topChromeWindow.OpenMessageForMessageId(
      id.substring(1, id.length - 1)
    );
  },

  openBrowser(event) {
    let id = event.currentTarget.parentNode.headerField.id;
    // Remove the < and > symbols.
    window.browsingContext.topChromeWindow.OpenBrowserWithMessageId(
      id.substring(1, id.length - 1)
    );
  },

  copyMessageId(event) {
    navigator.clipboard.writeText(
      event.currentTarget.parentNode.headerField.id
    );
  },

  copyWebsiteUrl(event) {
    navigator.clipboard.writeText(
      event.currentTarget.parentNode.headerField.value.textContent
    );
  },
};

function MarkSelectedMessagesRead(markRead) {
  ClearPendingReadTimer();
  gDBView.doCommand(
    markRead
      ? Ci.nsMsgViewCommandType.markMessagesRead
      : Ci.nsMsgViewCommandType.markMessagesUnread
  );
  if (markRead) {
    reportMsgRead({ isNewRead: true });
  }
}

function MarkSelectedMessagesFlagged(markFlagged) {
  gDBView.doCommand(
    markFlagged
      ? Ci.nsMsgViewCommandType.flagMessages
      : Ci.nsMsgViewCommandType.unflagMessages
  );
}

/**
 * Take the message id from the messageIdNode and use the url defined in the
 * hidden pref "mailnews.messageid_browser.url" to open it in a browser window
 * (%mid is replaced by the message id).
 * @param messageId the message id to open
 */
function OpenBrowserWithMessageId(messageId) {
  var browserURL = Services.prefs.getComplexValue(
    "mailnews.messageid_browser.url",
    Ci.nsIPrefLocalizedString
  ).data;
  browserURL = browserURL.replace(/%mid/, messageId);
  try {
    top.messenger.launchExternalURL(browserURL);
  } catch (ex) {
    console.error(
      "Failed to open message-id in browser; browserURL=" + browserURL
    );
  }
}

/**
 * Take the message id from the messageIdNode, search for the corresponding
 * message in all folders starting with the current selected folder, then the
 * current account followed by the other accounts and open corresponding
 * message if found.
 * @param messageId the message id to open
 */
function OpenMessageForMessageId(messageId) {
  let startServer = gFolder?.server;

  window.setCursor("wait");
  let { MailUtils } = ChromeUtils.import("resource:///modules/MailUtils.jsm");
  let messageHeader = MailUtils.getMsgHdrForMsgId(messageId, startServer);
  window.setCursor("auto");

  // if message id was found open corresponding message
  // else show error message
  if (messageHeader) {
    OpenMessageByHeader(
      messageHeader,
      Services.prefs.getBoolPref("mailnews.messageid.openInNewWindow")
    );
  } else {
    let messageIdStr = "<" + messageId + ">";
    let bundle = document.getElementById("bundle_messenger");
    let errorTitle = bundle.getString("errorOpenMessageForMessageIdTitle");
    let errorMessage = bundle.getFormattedString(
      "errorOpenMessageForMessageIdMessage",
      [messageIdStr]
    );

    Services.prompt.alert(window, errorTitle, errorMessage);
  }
}

function OpenMessageByHeader(messageHeader, openInNewWindow) {
  if (openInNewWindow) {
    window.openDialog(
      "chrome://messenger/content/messageWindow.xhtml",
      "_blank",
      "all,chrome,dialog=no,status,toolbar",
      messageHeader
    );
  } else {
    // TODO: Reimplement this?
  }
}

/**
 * @param headermode {Ci.nsMimeHeaderDisplayTypes}
 */
function AdjustHeaderView(headermode) {
  const all = Ci.nsMimeHeaderDisplayTypes.AllHeaders;
  document
    .getElementById("messageHeader")
    .setAttribute("show_header_mode", headermode == all ? "all" : "normal");
}

/**
 * Should the reply command/button be enabled?
 *
 * @return whether the reply command/button should be enabled.
 */
function IsReplyEnabled() {
  // If we're in an rss item, we never want to Reply, because there's
  // usually no-one useful to reply to.
  return !FeedUtils.isFeedMessage(gMessage);
}

/**
 * Should the reply-all command/button be enabled?
 *
 * @return whether the reply-all command/button should be enabled.
 */
function IsReplyAllEnabled() {
  if (gFolder?.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false)) {
    // If we're in a news item, we always want ReplyAll, because we can
    // reply to the sender and the newsgroup.
    return true;
  }
  if (FeedUtils.isFeedMessage(gMessage)) {
    // If we're in an rss item, we never want to ReplyAll, because there's
    // usually no-one useful to reply to.
    return false;
  }

  let addresses =
    gMessage.author + "," + gMessage.recipients + "," + gMessage.ccList;

  // If we've got any BCCed addresses (because we sent the message), add
  // them as well.
  if ("bcc" in currentHeaderData) {
    addresses += currentHeaderData.bcc.headerValue;
  }

  // Check to see if my email address is in the list of addresses.
  let [myIdentity] = MailUtils.getIdentityForHeader(gMessage);
  let myEmail = myIdentity ? myIdentity.email : null;
  // We aren't guaranteed to have an email address, so guard against that.
  let imInAddresses =
    myEmail && addresses.toLowerCase().includes(myEmail.toLowerCase());

  // Now, let's get the number of unique addresses.
  let uniqueAddresses = MailServices.headerParser.removeDuplicateAddresses(
    addresses,
    ""
  );
  let numAddresses = MailServices.headerParser.parseEncodedHeader(
    uniqueAddresses
  ).length;

  // I don't want to count my address in the number of addresses to reply
  // to, since I won't be emailing myself.
  if (imInAddresses) {
    numAddresses--;
  }

  // ReplyAll is enabled if there is more than 1 person to reply to.
  return numAddresses > 1;
}

/**
 * Should the reply-list command/button be enabled?
 *
 * @return whether the reply-list command/button should be enabled.
 */
function IsReplyListEnabled() {
  // ReplyToList is enabled if there is a List-Post header
  // with the correct format.
  let listPost = currentHeaderData["list-post"];
  if (!listPost) {
    return false;
  }

  // XXX: Once Bug 496914 provides a parser, we should use that instead.
  // Until then, we need to keep the following regex in sync with the
  // listPost parsing in nsMsgCompose.cpp's
  // QuotingOutputStreamListener::OnStopRequest.
  return /<mailto:.+>/.test(listPost.headerValue);
}

/**
 * Update the enabled/disabled states of the Reply, Reply-All, and
 * Reply-List buttons.  (After this function runs, one of the buttons
 * should be shown, and the others should be hidden.)
 */
function UpdateReplyButtons() {
  // If we have no message, because we're being called from
  // MailToolboxCustomizeDone before someone selected a message, then just
  // return.
  if (!gMessage) {
    return;
  }

  let buttonToShow;
  if (gFolder?.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false)) {
    // News messages always default to the "followup" dual-button.
    buttonToShow = "followup";
  } else if (FeedUtils.isFeedMessage(gMessage)) {
    // RSS items hide all the reply buttons.
    buttonToShow = null;
  } else if (IsReplyListEnabled()) {
    // Mail messages show the "reply" button (not the dual-button) and
    // possibly the "reply all" and "reply list" buttons.
    buttonToShow = "replyList";
  } else if (IsReplyAllEnabled()) {
    buttonToShow = "replyAll";
  } else {
    buttonToShow = "reply";
  }

  let smartReplyButton = document.getElementById("hdrSmartReplyButton");
  if (smartReplyButton) {
    let replyButton = document.getElementById("hdrReplyButton");
    let replyAllButton = document.getElementById("hdrReplyAllButton");
    let replyListButton = document.getElementById("hdrReplyListButton");
    let followupButton = document.getElementById("hdrFollowupButton");

    replyButton.hidden = buttonToShow != "reply";
    replyAllButton.hidden = buttonToShow != "replyAll";
    replyListButton.hidden = buttonToShow != "replyList";
    followupButton.hidden = buttonToShow != "followup";
  }

  let replyToSenderButton = document.getElementById("hdrReplyToSenderButton");
  if (replyToSenderButton) {
    if (FeedUtils.isFeedMessage(gMessage)) {
      replyToSenderButton.hidden = true;
    } else if (smartReplyButton) {
      replyToSenderButton.hidden = buttonToShow == "reply";
    } else {
      replyToSenderButton.hidden = false;
    }
  }

  goUpdateCommand("button_reply");
  goUpdateCommand("button_replyall");
  goUpdateCommand("button_replylist");
  goUpdateCommand("button_followup");
}

function SelectedMessagesAreJunk() {
  try {
    let junkScore = gMessage.getStringProperty("junkscore");
    return junkScore != "" && junkScore != "0";
  } catch (ex) {
    return false;
  }
}

function SelectedMessagesAreRead() {
  return gMessage?.isRead;
}

function SelectedMessagesAreFlagged() {
  return gMessage?.isFlagged;
}

function MsgReplyMessage(event) {
  if (gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false)) {
    MsgReplyGroup(event);
  } else {
    MsgReplySender(event);
  }
}

function MsgReplySender(event) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.ReplyToSender, event);
}

function MsgReplyGroup(event) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.ReplyToGroup, event);
}

function MsgReplyToAllMessage(event) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.ReplyAll, event);
}

function MsgReplyToListMessage(event) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.ReplyToList, event);
}

/**
 * Archives the selected messages
 *
 * @param event the event that caused us to call this function
 */
function MsgArchiveSelectedMessages(event) {
  let archiver = new MessageArchiver();
  archiver.msgWindow = top.msgWindow;
  archiver.archiveMessages([gMessage]);
}

function MsgForwardMessage(event) {
  var forwardType = Services.prefs.getIntPref("mail.forward_message_mode", 0);

  // mail.forward_message_mode could be 1, if the user migrated from 4.x
  // 1 (forward as quoted) is obsolete, so we treat is as forward inline
  // since that is more like forward as quoted then forward as attachment
  if (forwardType == 0) {
    MsgForwardAsAttachment(event);
  } else {
    MsgForwardAsInline(event);
  }
}

function MsgForwardAsAttachment(event) {
  commandController._composeMsgByType(
    Ci.nsIMsgCompType.ForwardAsAttachment,
    event
  );
}

function MsgForwardAsInline(event) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.ForwardInline, event);
}

function MsgRedirectMessage(event) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.Redirect, event);
}

function MsgEditMessageAsNew(aEvent) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.EditAsNew, aEvent);
}

function MsgEditDraftMessage(aEvent) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.Draft, aEvent);
}

function MsgNewMessageFromTemplate(aEvent) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.Template, aEvent);
}

function MsgEditTemplateMessage(aEvent) {
  commandController._composeMsgByType(Ci.nsIMsgCompType.EditTemplate, aEvent);
}

function MsgComposeDraftMessage() {
  top.ComposeMessage(
    Ci.nsIMsgCompType.Draft,
    Ci.nsIMsgCompFormat.Default,
    gFolder,
    [gMessageURI]
  );
}

/**
 * Update the "mark as junk" button in the message header area.
 */
function UpdateJunkButton() {
  // The junk message should slave off the selected message, as the preview pane
  //  may not be visible
  // But only the message display knows if we are dealing with a dummy.
  if (!gMessage || !gFolder) {
    // .eml file
    return;
  }
  let junkScore = gMessage.getStringProperty("junkscore");
  let hideJunk = junkScore == Ci.nsIJunkMailPlugin.IS_SPAM_SCORE;
  if (!commandController._getViewCommandStatus(Ci.nsMsgViewCommandType.junk)) {
    hideJunk = true;
  }
  if (document.getElementById("hdrJunkButton")) {
    document.getElementById("hdrJunkButton").disabled = hideJunk;
  }
}

/**
 * Checks if the selected messages can be marked as read or unread
 *
 * @param markingRead true if trying to mark messages as read, false otherwise
 * @return true if the chosen operation can be performed
 */
function CanMarkMsgAsRead(markingRead) {
  return gMessage && SelectedMessagesAreRead() != markingRead;
}

/**
 * Marks the selected messages as read or unread
 *
 * @param read true if trying to mark messages as read, false if marking unread,
 *        undefined if toggling the read status
 */
function MsgMarkMsgAsRead(read) {
  if (read == undefined) {
    read = !gMessage.isRead;
  }
  MarkSelectedMessagesRead(read);
}

function MsgMarkAsFlagged() {
  MarkSelectedMessagesFlagged(!SelectedMessagesAreFlagged());
}

/**
 * Triggered by the onHdrPropertyChanged notification for a single message being
 *  displayed. We handle updating the message display if our displayed message
 *  might have had its junk status change. This primarily entails updating the
 *  notification bar (that thing that appears above the message and says "this
 *  message might be junk") and (potentially) reloading the message because junk
 *  status affects the form of HTML display used (sanitized vs not).
 * When our tab implementation is no longer multiplexed (reusing the same
 *  display widget), this must be moved into the MessageDisplayWidget or
 *  otherwise be scoped to the tab.
 *
 * @param {nsIMsgHdr} msgHdr - The nsIMsgHdr of the message with a junk status change.
 */
function HandleJunkStatusChanged(msgHdr) {
  if (!msgHdr || !msgHdr.folder) {
    return;
  }

  let junkBarStatus = gMessageNotificationBar.checkJunkMsgStatus(msgHdr);

  // Only reload message if junk bar display state is changing and only if the
  // reload is really needed.
  if (junkBarStatus != 0) {
    // We may be forcing junk mail to be rendered with sanitized html.
    // In that scenario, we want to reload the message if the status has just
    // changed to not junk.
    var sanitizeJunkMail = Services.prefs.getBoolPref(
      "mail.spam.display.sanitize"
    );

    // Only bother doing this if we are modifying the html for junk mail....
    if (sanitizeJunkMail) {
      let junkScore = msgHdr.getStringProperty("junkscore");
      let isJunk = junkScore == Ci.nsIJunkMailPlugin.IS_SPAM_SCORE;

      // If the current row isn't going to change, reload to show sanitized or
      // unsanitized. Otherwise we wouldn't see the reloaded version anyway.
      // 1) When marking as non-junk from the Junk folder, the msg would move
      //    back to the Inbox -> no reload needed
      //    When marking as non-junk from a folder other than the Junk folder,
      //    the message isn't moved back to Inbox -> reload needed
      //    (see nsMsgDBView::DetermineActionsForJunkChange)
      // 2) When marking as junk, the msg will move or delete, if manualMark is set.
      // 3) Marking as junk in the junk folder just changes the junk status.
      if (
        (!isJunk && !msgHdr.folder.isSpecialFolder(Ci.nsMsgFolderFlags.Junk)) ||
        (isJunk && !msgHdr.folder.server.spamSettings.manualMark) ||
        (isJunk && msgHdr.folder.isSpecialFolder(Ci.nsMsgFolderFlags.Junk))
      ) {
        ReloadMessage();
        return;
      }
    }
  }

  gMessageNotificationBar.setJunkMsg(msgHdr);
}

/**
 * Object to handle message related notifications that are showing in a
 * notificationbox above the message content.
 */
var gMessageNotificationBar = {
  get stringBundle() {
    delete this.stringBundle;
    return (this.stringBundle = document.getElementById("bundle_messenger"));
  },

  get brandBundle() {
    delete this.brandBundle;
    return (this.brandBundle = document.getElementById("bundle_brand"));
  },

  get msgNotificationBar() {
    if (!this._notificationBox) {
      this._notificationBox = new MozElements.NotificationBox(element => {
        element.setAttribute("notificationside", "top");
        document.getElementById("mail-notification-top").append(element);
      });
    }
    return this._notificationBox;
  },

  /**
   * Check if the current status of the junk notification is correct or not.
   *
   * @param {nsIMsgDBHdr} aMsgHdr - Information about the message
   * @returns {integer} Tri-state status information.
   *    1: notification is missing
   *    0: notification is correct
   *   -1: notification must be removed
   */
  checkJunkMsgStatus(aMsgHdr) {
    let junkScore = aMsgHdr ? aMsgHdr.getStringProperty("junkscore") : "";
    let junkStatus = this.isShowingJunkNotification();

    if (junkScore == "" || junkScore == Ci.nsIJunkMailPlugin.IS_HAM_SCORE) {
      // This is not junk. The notification should not be shown.
      return junkStatus ? -1 : 0;
    }

    // This is junk. The notification should be shown.
    return junkStatus ? 0 : 1;
  },

  setJunkMsg(aMsgHdr) {
    goUpdateCommand("button_junk");

    let junkBarStatus = this.checkJunkMsgStatus(aMsgHdr);
    if (junkBarStatus == -1) {
      this.msgNotificationBar.removeNotification(
        this.msgNotificationBar.getNotificationWithValue("junkContent"),
        true
      );
    } else if (junkBarStatus == 1) {
      let brandName = this.brandBundle.getString("brandShortName");
      let junkBarMsg = this.stringBundle.getFormattedString("junkBarMessage", [
        brandName,
      ]);

      let buttons = [
        {
          label: this.stringBundle.getString("junkBarInfoButton"),
          accessKey: this.stringBundle.getString("junkBarInfoButtonKey"),
          popup: null,
          callback(aNotification, aButton) {
            // TODO: This doesn't work in a message window.
            top.openContentTab(
              "https://support.mozilla.org/kb/thunderbird-and-junk-spam-messages"
            );
            return true; // keep notification open
          },
        },
        {
          label: this.stringBundle.getString("junkBarButton"),
          accessKey: this.stringBundle.getString("junkBarButtonKey"),
          popup: null,
          callback(aNotification, aButton) {
            commandController.doCommand("cmd_markAsNotJunk");
            // Return true (=don't close) since changing junk status will fire a
            // JunkStatusChanged notification which will make the junk bar go away
            // for this message -> no notification to close anymore -> trying to
            // close would just fail.
            return true;
          },
        },
      ];

      this.msgNotificationBar.appendNotification(
        "junkContent",
        {
          label: junkBarMsg,
          image: "chrome://messenger/skin/icons/junk.svg",
          priority: this.msgNotificationBar.PRIORITY_WARNING_HIGH,
        },
        buttons
      );
    }
  },

  isShowingJunkNotification() {
    return !!this.msgNotificationBar.getNotificationWithValue("junkContent");
  },

  setRemoteContentMsg(aMsgHdr, aContentURI, aCanOverride) {
    // update the allow remote content for sender string
    let brandName = this.brandBundle.getString("brandShortName");
    let remoteContentMsg = this.stringBundle.getFormattedString(
      "remoteContentBarMessage",
      [brandName]
    );

    let buttonLabel = this.stringBundle.getString(
      AppConstants.platform == "win"
        ? "remoteContentPrefLabel"
        : "remoteContentPrefLabelUnix"
    );
    let buttonAccesskey = this.stringBundle.getString(
      AppConstants.platform == "win"
        ? "remoteContentPrefAccesskey"
        : "remoteContentPrefAccesskeyUnix"
    );

    let buttons = [
      {
        label: buttonLabel,
        accessKey: buttonAccesskey,
        popup: "remoteContentOptions",
        callback() {},
      },
    ];

    // The popup value is a space separated list of all the blocked origins.
    let popup = document.getElementById("remoteContentOptions");
    let principal = Services.scriptSecurityManager.createContentPrincipal(
      aContentURI,
      {}
    );
    let origins = popup.value ? popup.value.split(" ") : [];
    if (!origins.includes(principal.origin)) {
      origins.push(principal.origin);
    }
    popup.value = origins.join(" ");

    if (!this.isShowingRemoteContentNotification()) {
      let notification = this.msgNotificationBar.appendNotification(
        "remoteContent",
        {
          label: remoteContentMsg,
          image: "chrome://messenger/skin/icons/remote-blocked.svg",
          priority: this.msgNotificationBar.PRIORITY_WARNING_MEDIUM,
        },
        aCanOverride ? buttons : []
      );

      notification.buttonContainer.firstElementChild.classList.add(
        "button-menu-list"
      );
    }
  },

  isShowingRemoteContentNotification() {
    return !!this.msgNotificationBar.getNotificationWithValue("remoteContent");
  },

  setPhishingMsg() {
    let phishingMsgNote = this.stringBundle.getString("phishingBarMessage");

    let buttonLabel = this.stringBundle.getString(
      AppConstants.platform == "win"
        ? "phishingBarPrefLabel"
        : "phishingBarPrefLabelUnix"
    );
    let buttonAccesskey = this.stringBundle.getString(
      AppConstants.platform == "win"
        ? "phishingBarPrefAccesskey"
        : "phishingBarPrefAccesskeyUnix"
    );

    let buttons = [
      {
        label: buttonLabel,
        accessKey: buttonAccesskey,
        popup: "phishingOptions",
        callback(aNotification, aButton) {},
      },
    ];

    if (!this.isShowingPhishingNotification()) {
      let notification = this.msgNotificationBar.appendNotification(
        "maybeScam",
        {
          label: phishingMsgNote,
          image: "chrome://messenger/skin/icons/phishing.svg",
          priority: this.msgNotificationBar.PRIORITY_CRITICAL_MEDIUM,
        },
        buttons
      );

      notification.buttonContainer.firstElementChild.classList.add(
        "button-menu-list"
      );
    }
  },

  isShowingPhishingNotification() {
    return !!this.msgNotificationBar.getNotificationWithValue("maybeScam");
  },

  setMDNMsg(aMdnGenerator, aMsgHeader, aMimeHdr) {
    this.mdnGenerator = aMdnGenerator;
    // Return receipts can be RFC 3798 or not.
    let mdnHdr =
      aMimeHdr.extractHeader("Disposition-Notification-To", false) ||
      aMimeHdr.extractHeader("Return-Receipt-To", false); // not
    let fromHdr = aMimeHdr.extractHeader("From", false);

    let mdnAddr = MailServices.headerParser.extractHeaderAddressMailboxes(
      mdnHdr
    );
    let fromAddr = MailServices.headerParser.extractHeaderAddressMailboxes(
      fromHdr
    );

    let authorName =
      MailServices.headerParser.extractFirstName(
        aMsgHeader.mime2DecodedAuthor
      ) || aMsgHeader.author;

    // If the return receipt doesn't go to the sender address, note that in the
    // notification.
    let mdnBarMsg =
      mdnAddr != fromAddr
        ? this.stringBundle.getFormattedString("mdnBarMessageAddressDiffers", [
            authorName,
            mdnAddr,
          ])
        : this.stringBundle.getFormattedString("mdnBarMessageNormal", [
            authorName,
          ]);

    let buttons = [
      {
        label: this.stringBundle.getString("mdnBarSendReqButton"),
        accessKey: this.stringBundle.getString("mdnBarSendReqButtonKey"),
        popup: null,
        callback(aNotification, aButton) {
          SendMDNResponse();
          return false; // close notification
        },
      },
      {
        label: this.stringBundle.getString("mdnBarIgnoreButton"),
        accessKey: this.stringBundle.getString("mdnBarIgnoreButtonKey"),
        popup: null,
        callback(aNotification, aButton) {
          IgnoreMDNResponse();
          return false; // close notification
        },
      },
    ];

    this.msgNotificationBar.appendNotification(
      "mdnRequested",
      {
        label: mdnBarMsg,
        priority: this.msgNotificationBar.PRIORITY_INFO_MEDIUM,
      },
      buttons
    );
  },

  setDraftEditMessage() {
    if (!gMessage || !gFolder) {
      return;
    }

    if (gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Drafts, true)) {
      let draftMsgNote = this.stringBundle.getString("draftMessageMsg");

      let buttons = [
        {
          label: this.stringBundle.getString("draftMessageButton"),
          accessKey: this.stringBundle.getString("draftMessageButtonKey"),
          popup: null,
          callback(aNotification, aButton) {
            MsgComposeDraftMessage();
            return true; // keep notification open
          },
        },
      ];

      this.msgNotificationBar.appendNotification(
        "draftMsgContent",
        {
          label: draftMsgNote,
          priority: this.msgNotificationBar.PRIORITY_INFO_HIGH,
        },
        buttons
      );
    }
  },

  clearMsgNotifications() {
    this.msgNotificationBar.removeAllNotifications(true);
  },
};

/**
 * LoadMsgWithRemoteContent
 *   Reload the current message, allowing remote content
 */
function LoadMsgWithRemoteContent() {
  // we want to get the msg hdr for the currently selected message
  // change the "remoteContentBar" property on it
  // then reload the message

  setMsgHdrPropertyAndReload("remoteContentPolicy", kAllowRemoteContent);
  window.content.focus();
}

/**
 * Populate the remote content options for the current message.
 */
function onRemoteContentOptionsShowing(aEvent) {
  let origins = aEvent.target.value ? aEvent.target.value.split(" ") : [];

  let addresses = MailServices.headerParser.parseEncodedHeader(gMessage.author);
  addresses = addresses.slice(0, 1);
  // If there is an author's email, put it also in the menu.
  let adrCount = addresses.length;
  if (adrCount > 0) {
    let authorEmailAddress = addresses[0].email;
    let authorEmailAddressURI = Services.io.newURI(
      "chrome://messenger/content/email=" + authorEmailAddress
    );
    let mailPrincipal = Services.scriptSecurityManager.createContentPrincipal(
      authorEmailAddressURI,
      {}
    );
    origins.push(mailPrincipal.origin);
  }

  let messengerBundle = document.getElementById("bundle_messenger");

  // Out with the old...
  let children = aEvent.target.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].getAttribute("class") == "allow-remote-uri") {
      children[i].remove();
    }
  }

  let urlSepar = document.getElementById("remoteContentAllMenuSeparator");

  // ... and in with the new.
  for (let origin of origins) {
    let menuitem = document.createXULElement("menuitem");
    menuitem.setAttribute(
      "label",
      messengerBundle.getFormattedString("remoteAllowResource", [
        origin.replace("chrome://messenger/content/email=", ""),
      ])
    );
    menuitem.setAttribute("value", origin);
    menuitem.setAttribute("class", "allow-remote-uri");
    menuitem.setAttribute("oncommand", "allowRemoteContentForURI(this.value);");
    if (origin.startsWith("chrome://messenger/content/email=")) {
      aEvent.target.appendChild(menuitem);
    } else {
      aEvent.target.insertBefore(menuitem, urlSepar);
    }
  }

  let URLcount = origins.length - adrCount;
  let allowAllItem = document.getElementById("remoteContentOptionAllowAll");
  let allURLLabel = messengerBundle.getString("remoteAllowAll");
  allowAllItem.label = PluralForm.get(URLcount, allURLLabel).replace(
    "#1",
    URLcount
  );

  allowAllItem.collapsed = URLcount < 2;
  document.getElementById(
    "remoteContentOriginsMenuSeparator"
  ).collapsed = urlSepar.collapsed = allowAllItem.collapsed && adrCount == 0;
}

/**
 * Add privileges to display remote content for the given uri.
 *
 * @param aUriSpec |String| uri for the site to add permissions for.
 * @param aReload  Reload the message display after allowing the URI.
 */
function allowRemoteContentForURI(aUriSpec, aReload = true) {
  let uri = Services.io.newURI(aUriSpec);
  Services.perms.addFromPrincipal(
    Services.scriptSecurityManager.createContentPrincipal(uri, {}),
    "image",
    Services.perms.ALLOW_ACTION
  );
  if (aReload) {
    ReloadMessage();
  }
}

/**
 * Add privileges to display remote content for the given uri.
 *
 * @param aListNode  The menulist element containing the URIs to allow.
 */
function allowRemoteContentForAll(aListNode) {
  let uriNodes = aListNode.querySelectorAll(".allow-remote-uri");
  for (let uriNode of uriNodes) {
    if (!uriNode.value.startsWith("chrome://messenger/content/email=")) {
      allowRemoteContentForURI(uriNode.value, false);
    }
  }
  ReloadMessage();
}

/**
 * Displays fine-grained, per-site preferences for remote content.
 */
function editRemoteContentSettings() {
  top.openOptionsDialog("panePrivacy", "privacyCategory");
}

/**
 *  Set the msg hdr flag to ignore the phishing warning and reload the message.
 */
function IgnorePhishingWarning() {
  // This property should really be called skipPhishingWarning or something
  // like that, but it's too late to change that now.
  // This property is used to suppress the phishing bar for the message.
  setMsgHdrPropertyAndReload("notAPhishMessage", 1);
}

/**
 *  Open the preferences dialog to allow disabling the scam feature.
 */
function OpenPhishingSettings() {
  top.openOptionsDialog("panePrivacy", "privacySecurityCategory");
}

function setMsgHdrPropertyAndReload(aProperty, aValue) {
  // we want to get the msg hdr for the currently selected message
  // change the appropriate property on it then reload the message
  if (gMessage) {
    gMessage.setUint32Property(aProperty, aValue);
    ReloadMessage();
  }
}

/**
 * Mark a specified message as read.
 * @param msgHdr header (nsIMsgDBHdr) of the message to mark as read
 */
function MarkMessageAsRead(msgHdr) {
  ClearPendingReadTimer();
  msgHdr.folder.markMessagesRead([msgHdr], true);
  reportMsgRead({ isNewRead: true });
}

function ClearPendingReadTimer() {
  if (gMarkViewedMessageAsReadTimer) {
    clearTimeout(gMarkViewedMessageAsReadTimer);
    gMarkViewedMessageAsReadTimer = null;
  }
}

// this is called when layout is actually finished rendering a
// mail message. OnMsgLoaded is called when libmime is done parsing the message
function OnMsgParsed(aUrl) {
  // browser doesn't do this, but I thought it could be a useful thing to test out...
  // If the find bar is visible and we just loaded a new message, re-run
  // the find command. This means the new message will get highlighted and
  // we'll scroll to the first word in the message that matches the find text.
  var findBar = document.getElementById("FindToolbar");
  if (!findBar.hidden) {
    findBar.onFindAgainCommand(false);
  }

  let browser = getMessagePaneBrowser();
  // Run the phishing detector on the message if it hasn't been marked as not
  // a scam already.
  if (
    gMessage &&
    !gMessage.getUint32Property("notAPhishMessage") &&
    PhishingDetector.analyzeMsgForPhishingURLs(aUrl, browser)
  ) {
    gMessageNotificationBar.setPhishingMsg();
  }

  // Notify anyone (e.g., extensions) who's interested in when a message is loaded.
  Services.obs.notifyObservers(null, "MsgMsgDisplayed", gMessageURI);

  let doc = browser && browser.contentDocument ? browser.contentDocument : null;

  // Rewrite any anchor elements' href attribute to reflect that the loaded
  // document is a mailnews url. This will cause docShell to scroll to the
  // element in the document rather than opening the link externally.
  let links = doc && doc.links ? doc.links : [];
  for (let linkNode of links) {
    if (!linkNode.hash) {
      continue;
    }

    // We have a ref fragment which may reference a node in this document.
    // Ensure html in mail anchors work as expected.
    let anchorId = linkNode.hash.replace("#", "");
    // Continue if an id (html5) or name attribute value for the ref is not
    // found in this document.
    let selector = "#" + anchorId + ", [name='" + anchorId + "']";
    try {
      if (!linkNode.ownerDocument.querySelector(selector)) {
        continue;
      }
    } catch (ex) {
      continue;
    }

    // Then check if the href url matches the document baseURL.
    if (
      makeURI(linkNode.href).specIgnoringRef !=
      makeURI(linkNode.baseURI).specIgnoringRef
    ) {
      continue;
    }

    // Finally, if the document url is a message url, and the anchor href is
    // http, it needs to be adjusted so docShell finds the node.
    let messageURI = makeURI(linkNode.ownerDocument.URL);
    if (
      messageURI instanceof Ci.nsIMsgMailNewsUrl &&
      linkNode.href.startsWith("http")
    ) {
      linkNode.href = messageURI.specIgnoringRef + linkNode.hash;
    }
  }

  // Scale any overflowing images, exclude http content.
  let imgs = doc && !doc.URL.startsWith("http") ? doc.images : [];
  for (let img of imgs) {
    if (
      img.clientWidth - doc.body.offsetWidth >= 0 &&
      (img.clientWidth <= img.naturalWidth || !img.naturalWidth)
    ) {
      img.setAttribute("overflowing", "true");
    }

    // This is the default case for images when a message is loaded.
    img.setAttribute("shrinktofit", "true");
  }
}

function OnMsgLoaded(aUrl) {
  if (!aUrl) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("MsgLoaded", { detail: gMessage, bubbles: true })
  );
  window.dispatchEvent(
    new CustomEvent("MsgsLoaded", { detail: [gMessage], bubbles: true })
  );

  if (!gFolder) {
    return;
  }

  let win =
    location.href == "about:message"
      ? window.browsingContext.topChromeWindow
      : window;
  let wintype = win.document.documentElement.getAttribute("windowtype");

  gMessageNotificationBar.setJunkMsg(gMessage);

  goUpdateCommand("button_delete");

  let markReadAutoMode = Services.prefs.getBoolPref(
    "mailnews.mark_message_read.auto"
  );

  // We just finished loading a message. If messages are to be marked as read
  // automatically, set a timer to mark the message is read after n seconds
  // where n can be configured by the user.
  if (gMessage && !gMessage.isRead && markReadAutoMode) {
    let markReadOnADelay = Services.prefs.getBoolPref(
      "mailnews.mark_message_read.delay"
    );

    // Only use the timer if viewing using the 3-pane preview pane and the
    // user has set the pref.
    if (markReadOnADelay && wintype == "mail:3pane") {
      // 3-pane window
      ClearPendingReadTimer();
      let markReadDelayTime = Services.prefs.getIntPref(
        "mailnews.mark_message_read.delay.interval"
      );
      if (markReadDelayTime == 0) {
        MarkMessageAsRead(gMessage);
      } else {
        gMarkViewedMessageAsReadTimer = setTimeout(
          MarkMessageAsRead,
          markReadDelayTime * 1000,
          gMessage
        );
      }
    } else {
      // standalone msg window
      MarkMessageAsRead(gMessage);
    }
  }

  // See if MDN was requested but has not been sent.
  HandleMDNResponse(aUrl);
}

/**
 * This function handles all mdn response generation (ie, imap and pop).
 * For pop the msg uid can be 0 (ie, 1st msg in a local folder) so no
 * need to check uid here. No one seems to set mimeHeaders to null so
 * no need to check it either.
 */
function HandleMDNResponse(aUrl) {
  if (!aUrl) {
    return;
  }

  var msgFolder = aUrl.folder;
  if (
    !msgFolder ||
    !gMessage ||
    gFolder.isSpecialFolder(Ci.nsMsgFolderFlags.Newsgroup, false)
  ) {
    return;
  }

  // if the message is marked as junk, do NOT attempt to process a return receipt
  // in order to better protect the user
  if (SelectedMessagesAreJunk()) {
    return;
  }

  var mimeHdr;

  try {
    mimeHdr = aUrl.mimeHeaders;
  } catch (ex) {
    return;
  }

  // If we didn't get the message id when we downloaded the message header,
  // we cons up an md5: message id. If we've done that, we'll try to extract
  // the message id out of the mime headers for the whole message.
  let msgId = gMessage.messageId;
  if (msgId.startsWith("md5:")) {
    var mimeMsgId = mimeHdr.extractHeader("Message-Id", false);
    if (mimeMsgId) {
      gMessage.messageId = mimeMsgId;
    }
  }

  // After a msg is downloaded it's already marked READ at this point so we must check if
  // the msg has a "Disposition-Notification-To" header and no MDN report has been sent yet.
  if (gMessage.flags & Ci.nsMsgMessageFlags.MDNReportSent) {
    return;
  }

  var DNTHeader = mimeHdr.extractHeader("Disposition-Notification-To", false);
  var oldDNTHeader = mimeHdr.extractHeader("Return-Receipt-To", false);
  if (!DNTHeader && !oldDNTHeader) {
    return;
  }

  // Everything looks good so far, let's generate the MDN response.
  var mdnGenerator = Cc[
    "@mozilla.org/messenger-mdn/generator;1"
  ].createInstance(Ci.nsIMsgMdnGenerator);
  const MDN_DISPOSE_TYPE_DISPLAYED = 0;
  let askUser = mdnGenerator.process(
    MDN_DISPOSE_TYPE_DISPLAYED,
    top.msgWindow,
    msgFolder,
    gMessage.messageKey,
    mimeHdr,
    false
  );
  if (askUser) {
    gMessageNotificationBar.setMDNMsg(mdnGenerator, gMessage, mimeHdr);
  }
}

function SendMDNResponse() {
  gMessageNotificationBar.mdnGenerator.userAgreed();
}

function IgnoreMDNResponse() {
  gMessageNotificationBar.mdnGenerator.userDeclined();
}

// An object to help collecting reading statistics of secure emails.
var gSecureMsgProbe = {};

/**
 * Update gSecureMsgProbe and report to telemetry if necessary.
 */
function reportMsgRead({ isNewRead = false, key = null }) {
  if (isNewRead) {
    gSecureMsgProbe.isNewRead = true;
  }
  if (key) {
    gSecureMsgProbe.key = key;
  }
  if (gSecureMsgProbe.key && gSecureMsgProbe.isNewRead) {
    Services.telemetry.keyedScalarAdd(
      "tb.mails.read_secure",
      gSecureMsgProbe.key,
      1
    );
  }
}

window.addEventListener("secureMsgLoaded", event => {
  reportMsgRead({ key: event.detail.key });
});
