/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from SearchDialog.js */

/* globals ViewPickerBinding */ // From msgViewPickerOverlay.js

/* TODO: Now used exclusively in SearchDialog.xhtml. Needs dead code removal. */

var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  TreeSelection: "chrome://messenger/content/tree-selection.mjs",
});

XPCOMUtils.defineLazyModuleGetters(this, {
  DBViewWrapper: "resource:///modules/DBViewWrapper.jsm",
});

var gDBView;
var nsMsgKey_None = 0xffffffff;
var nsMsgViewIndex_None = 0xffffffff;

/**
 * Maintains a list of listeners for all FolderDisplayWidget instances in this
 *  window.  The assumption is that because of our multiplexed tab
 *  implementation all consumers are effectively going to care about all such
 *  tabs.
 *
 * We are not just a global list so that we can add brains about efficiently
 *  building lists, provide try-wrapper convenience, etc.
 */
var FolderDisplayListenerManager = {
  _listeners: [],

  /**
   * Register a listener that implements one or more of the methods defined on
   *  |IDBViewWrapperListener|.  Note that a change from those interface
   *  signatures is that the first argument is always a reference to the
   *  FolderDisplayWidget generating the notification.
   *
   * We additionally support the following notifications:
   * - onMakeActive.  Invoked when makeActive is called on the
   *   FolderDisplayWidget.  The second argument (after the folder display) is
   *   aWasInactive.
   *
   * - onActiveCreatedView.  onCreatedView deferred to when the tab is actually
   *   made active.
   *
   * - onActiveMessagesLoaded.  onMessagesLoaded deferred to when the
   *   tab is actually made active.  Use this if the actions you need to take
   *   are based on the folder display actually being visible, such as updating
   *   some UI widget, etc. Not all messages may have been loaded, but some.
   *
   */
  registerListener(aListener) {
    this._listeners.push(aListener);
  },

  /**
   * Unregister a previously registered event listener.
   */
  unregisterListener(aListener) {
    let idx = this._listeners.indexOf(aListener);
    if (idx >= 0) {
      this._listeners.splice(idx, 1);
    }
  },

  /**
   * For use by FolderDisplayWidget to trigger listener invocation.
   */
  _fireListeners(aEventName, aArgs) {
    for (let listener of this._listeners) {
      if (aEventName in listener) {
        try {
          listener[aEventName].apply(listener, aArgs);
        } catch (e) {
          console.error(
            aEventName + " event listener FAILED; " + e + " at: " + e.stack
          );
        }
      }
    }
  },
};

/**
 * Abstraction for a widget that (roughly speaking) displays the contents of
 *  folders.  The widget belongs to a tab and has a lifetime as long as the tab
 *  that contains it.  This class is strictly concerned with the UI aspects of
 *  this; the DBViewWrapper class handles the view details (and is exposed on
 *  the 'view' attribute.)
 *
 * The search window subclasses this into the SearchFolderDisplayWidget rather
 *  than us attempting to generalize everything excessively.  This is because
 *  we hate the search window and don't want to clutter up this code for it.
 * The standalone message display window also subclasses us; we do not hate it,
 *  but it's not invited to our birthday party either.
 * For reasons of simplicity and the original order of implementation, this
 *  class does alter its behavior slightly for the benefit of the standalone
 *  message window.  If no tab info is provided, we avoid touching tabmail
 *  (which is good, because it won't exist!)  And now we guard against treeBox
 *  manipulations...
 */
function FolderDisplayWidget() {
  // If the folder does not get handled by the DBViewWrapper, stash it here.
  //  ex: when isServer is true.
  this._nonViewFolder = null;

  this.view = new DBViewWrapper(this);

  /**
   * The XUL tree node, as retrieved by getDocumentElementById.  The caller is
   *  responsible for setting this.
   */
  this.tree = null;

  /**
   * The nsIMsgWindow corresponding to the window that holds us.  There is only
   *  one of these per tab.  The caller is responsible for setting this.
   */
  this.msgWindow = null;
  /**
   * The nsIMessenger instance that corresponds to our tab/window.  We do not
   *  use this ourselves, but are responsible for using it to update the
   *  global |messenger| object so that our tab maintains its own undo and
   *  navigation history.  At some point we might touch it for those reasons.
   */
  this.messenger = null;
  this.threadPaneCommandUpdater = this;

  /**
   * Flag to expose whether all messages are loaded or not.  Set by
   *  onMessagesLoaded() when aAll is true.
   */
  this._allMessagesLoaded = false;

  /**
   * Save the top row displayed when we go inactive, restore when we go active,
   *  nuke it when we destroy the view.
   */
  this._savedFirstVisibleRow = null;
  /** the next view index to select once the delete completes */
  this._nextViewIndexAfterDelete = null;
  /**
   * Track when a mass move is in effect (we get told by hintMassMoveStarting,
   *  and hintMassMoveCompleted) so that we can avoid deletion-triggered
   *  moving to _nextViewIndexAfterDelete until the mass move completes.
   */
  this._massMoveActive = false;
  /**
   * Track when a message is being deleted so we can respond appropriately.
   */
  this._deleteInProgress = false;

  /**
   * Used by pushNavigation to queue a navigation request for when we enter the
   *  next folder; onMessagesLoaded(true) is the one that processes it.
   */
  this._pendingNavigation = null;

  this._active = false;
  /**
   * A list of methods to call on 'this' object when we are next made active.
   *  This list is populated by calls to |_notifyWhenActive| when we are
   *  not active at the moment.
   */
  this._notificationsPendingActivation = [];

  /**
   * Create a fake tree object for if/when this folder is in the background.
   * Hide the tree using CSS, because if it's not attached to the document or
   * is hidden="true", it won't fire select events and stuff will break.
   */
  this._fakeTree = document.createXULElement("tree");
  this._fakeTree.setAttribute("style", "visibility: collapse");
  this._fakeTree.appendChild(document.createXULElement("treechildren"));
  document.documentElement.appendChild(this._fakeTree);

  /**
   * Create a fake tree selection for cases where we have opened a background
   * tab. We'll get rid of this as soon as we've switched to the tab for the
   * first time, and have a real tree selection.
   */
  this._fakeTreeSelection = new TreeSelection(this._fakeTree);

  this._mostRecentSelectionCounts = [];
  this._mostRecentCurrentIndices = [];
}
FolderDisplayWidget.prototype = {
  /**
   * @returns the currently displayed folder.  This is just proxied from the
   *     view wrapper.
   * @groupName Displayed
   */
  get displayedFolder() {
    return this._nonViewFolder || this.view.displayedFolder;
  },

  /**
   * @returns true if the selection should be summarized for this folder. This
   *     is based on the mail.operate_on_msgs_in_collapsed_threads pref and
   *     if we are in a newsgroup folder. XXX When bug 478167 is fixed, this
   *     should be limited to being disabled for newsgroups that are not stored
   *     offline.
   */
  get summarizeSelectionInFolder() {
    return (
      Services.prefs.getBoolPref("mail.operate_on_msgs_in_collapsed_threads") &&
      !(this.displayedFolder instanceof Ci.nsIMsgNewsFolder)
    );
  },

  /**
   * @returns the nsITreeSelection object for our tree view.  This exists for
   *     the benefit of message tabs that haven't been switched to yet.
   *     We provide a fake tree selection in those cases.
   * @protected
   */
  get treeSelection() {
    // If we haven't switched to this tab yet, dbView will exist but
    // dbView.selection won't, so use the fake tree selection instead.
    if (this._fakeTreeSelection) {
      return this._fakeTreeSelection;
    }
    if (this.view.dbView) {
      return this.view.dbView.selection;
    }
    return null;
  },

  /**
   * Determine which pane currently has focus (one of the folder pane, thread
   * pane, or message pane). The message pane node is the common ancestor of
   * the single- and multi-message content windows. When changing focus to the
   * message pane, be sure to focus the appropriate content window in addition
   * to the messagepanebox (doing both is required in order to blur the
   * previously-focused chrome element).
   *
   * @returns the focused pane
   */
  get focusedPane() {
    let panes = ["threadTree", "folderTree", "messagepanebox"].map(id =>
      document.getElementById(id)
    );

    let currentNode = top.document.activeElement;

    while (currentNode) {
      if (panes.includes(currentNode)) {
        return currentNode;
      }

      currentNode = currentNode.parentNode;
    }
    return null;
  },

  /**
   * Number of headers to tell the message database to cache when we enter a
   *  folder.  This value is being propagated from legacy code which provided
   *  no explanation for its choice.
   *
   * We definitely want the header cache size to be larger than the number of
   *  rows that can be displayed on screen simultaneously.
   *
   * @private
   */
  PERF_HEADER_CACHE_SIZE: 100,

  /**
   * @name Selection Persistence
   * @private
   */
  // @{

  /**
   * An optional object, with the following properties:
   * - messages: This is a list where each item is an object with the following
   *       attributes sufficient to re-establish the selected items even in the
   *       face of folder renaming.
   *   - messageId: The value of the message's message-id header.
   *
   * That's right, we only save the message-id header value.  This is arguably
   *  overkill and ambiguous in the face of duplicate messages, but it's the
   *  most persistent/reliable thing we have without gloda.
   * Using the view index was ruled out because it is hardly stable.  Using the
   *  message key alone is insufficient for cross-folder searches.  Using a
   *  folder identifier and message key is insufficient for local folders in the
   *  face of compaction, let alone complexities where the folder name may
   *  change due to renaming/moving.  Which means we eventually need to fall
   *  back to message-id anyways.  Feel free to add in lots of complexity if
   *  you actually write unit tests for all the many possible cases.
   * Additional justification is that selection saving/restoration should not
   *  happen all that frequently.  A nice freebie is that message-id is
   *  definitely persistable.
   *
   * - forceSelect: Whether we are allowed to drop all filters in our quest to
   *       select messages.
   */
  _savedSelection: null,

  /**
   * Save the current view selection for when we the view is getting destroyed
   *  or otherwise re-ordered in such a way that the nsITreeSelection will lose
   *  track of things (because it just has a naive view-index 'view' of the
   *  world.)  We just save each message's message-id header.  This is overkill
   *  and ambiguous in the face of duplicate messages (and expensive to
   *  restore), but is also the most reliable option for this use case.
   */
  _saveSelection() {
    this._savedSelection = {
      messages: this.selectedMessages.map(msgHdr => ({
        messageId: msgHdr.messageId,
      })),
      forceSelect: false,
    };
  },

  /**
   * Clear the saved selection.
   */
  _clearSavedSelection() {
    this._savedSelection = null;
  },

  /**
   * Restore the view selection if we have a saved selection.  We must be
   *  active!
   *
   * @returns true if we were able to restore the selection and there was
   *     a selection, false if there was no selection (anymore).
   */
  _restoreSelection() {
    if (!this._savedSelection || !this._active) {
      return false;
    }

    // translate message IDs back to messages.  this is O(s(m+n)) where:
    // - s is the number of messages saved in the selection
    // - m is the number of messages in the view (from findIndexOfMsgHdr)
    // - n is the number of messages in the underlying folders (from
    //   DBViewWrapper.getMsgHdrForMessageID).
    // which ends up being O(sn)
    let messages = this._savedSelection.messages
      .map(savedInfo => this.view.getMsgHdrForMessageID(savedInfo.messageId))
      .filter(msgHdr => !!msgHdr);

    this.selectMessages(messages, this._savedSelection.forceSelect, true);
    this._savedSelection = null;

    return this.selectedCount != 0;
  },

  /**
   * Restore the last expandAll/collapseAll state, for both grouped and threaded
   * views. Not all views respect viewFlags, ie single folder non-virtual.
   */
  restoreThreadState() {
    if (!this._active || !this.tree || !this.view.dbView.viewFolder) {
      return;
    }

    if (
      this.view._threadExpandAll &&
      !(this.view.dbView.viewFlags & Ci.nsMsgViewFlagsType.kExpandAll)
    ) {
      this.view.dbView.doCommand(Ci.nsMsgViewCommandType.expandAll);
    }
    if (
      !this.view._threadExpandAll &&
      this.view.dbView.viewFlags & Ci.nsMsgViewFlagsType.kExpandAll
    ) {
      this.view.dbView.doCommand(Ci.nsMsgViewCommandType.collapseAll);
    }
  },
  // @}

  /**
   * @name Columns
   * @protected
   */
  // @{

  /**
   * The map of all stock sortable columns and their sortType. The key must
   * match the column's xul <treecol> id.
   */
  COLUMNS_MAP: new Map([
    ["accountCol", "byAccount"],
    ["attachmentCol", "byAttachments"],
    ["senderCol", "byAuthor"],
    ["correspondentCol", "byCorrespondent"],
    ["dateCol", "byDate"],
    ["flaggedCol", "byFlagged"],
    ["idCol", "byId"],
    ["junkStatusCol", "byJunkStatus"],
    ["locationCol", "byLocation"],
    ["priorityCol", "byPriority"],
    ["receivedCol", "byReceived"],
    ["recipientCol", "byRecipient"],
    ["sizeCol", "bySize"],
    ["statusCol", "byStatus"],
    ["subjectCol", "bySubject"],
    ["tagsCol", "byTags"],
    ["threadCol", "byThread"],
    ["unreadButtonColHeader", "byUnread"],
  ]),

  /**
   * The map of stock non-sortable columns. The key must match the column's
   *  xul <treecol> id.
   */
  COLUMNS_MAP_NOSORT: new Set([
    "selectCol",
    "totalCol",
    "unreadCol",
    "deleteCol",
  ]),

  /**
   * The set of potential default columns in their default display order.  Each
   *  column in this list is checked against |COLUMN_DEFAULT_TESTERS| to see if
   *  it is actually an appropriate default for the folder type.
   */
  DEFAULT_COLUMNS: [
    "threadCol",
    "attachmentCol",
    "flaggedCol",
    "subjectCol",
    "unreadButtonColHeader",
    "senderCol", // news folders or incoming folders when correspondents not in use
    "recipientCol", // outgoing folders when correspondents not in use
    "correspondentCol", // mail folders
    "junkStatusCol",
    "dateCol",
    "locationCol", // multiple-folder backed folders
  ],

  /**
   * Maps column ids to functions that test whether the column is a good default
   *  for display for the folder.  Each function should expect a DBViewWrapper
   *  instance as its argument.  The intent is that the various helper
   *  properties like isMailFolder/isIncomingFolder/isOutgoingFolder allow the
   *  constraint to be expressed concisely.  If a helper does not exist, add
   *  one! (If doing so is out of reach, than access viewWrapper.displayedFolder
   *  to get at the nsIMsgFolder.)
   * If a column does not have a function, it is assumed that it should be
   *  displayed by default.
   */
  COLUMN_DEFAULT_TESTERS: {
    correspondentCol(viewWrapper) {
      if (Services.prefs.getBoolPref("mail.threadpane.use_correspondents")) {
        // Don't show the correspondent for news or RSS where it doesn't make sense.
        return viewWrapper.isMailFolder && !viewWrapper.isFeedFolder;
      }
      return false;
    },
    senderCol(viewWrapper) {
      if (Services.prefs.getBoolPref("mail.threadpane.use_correspondents")) {
        // Show the sender even if correspondent is enabled for news and feeds.
        return viewWrapper.isNewsFolder || viewWrapper.isFeedFolder;
      }
      // senderCol = From. You only care in incoming folders.
      return viewWrapper.isIncomingFolder;
    },
    recipientCol(viewWrapper) {
      if (Services.prefs.getBoolPref("mail.threadpane.use_correspondents")) {
        // No recipient column if we use correspondent.
        return false;
      }
      // recipientCol = To. You only care in outgoing folders.
      return viewWrapper.isOutgoingFolder;
    },
    // Only show the location column for non-single-folder results
    locationCol(viewWrapper) {
      return !viewWrapper.isSingleFolder;
    },
    // core UI does not provide an ability to mark newsgroup messages as spam
    junkStatusCol(viewWrapper) {
      return !viewWrapper.isNewsFolder;
    },
  },

  /**
   * The property name we use to store the column states on the
   *  dbFolderInfo.
   */
  PERSISTED_COLUMN_PROPERTY_NAME: "columnStates",

  /**
   * Given a dbFolderInfo, extract the persisted state from it if there is any.
   *
   * @returns null if there was no persisted state, the persisted state in object
   *     form otherwise.  (Ideally the state conforms to the documentation on
   *     |_savedColumnStates| but we can't stop people from doing bad things.)
   */
  _depersistColumnStatesFromDbFolderInfo(aDbFolderInfo) {
    let columnJsonString = aDbFolderInfo.getCharProperty(
      this.PERSISTED_COLUMN_PROPERTY_NAME
    );
    if (!columnJsonString) {
      return null;
    }

    return JSON.parse(columnJsonString);
  },

  /**
   * Persist the column state for the currently displayed folder.  We are
   *  assuming that the message database is already open when we are called and
   *  therefore that we do not need to worry about cleaning up after the message
   *  database.
   * The caller should only call this when they have reason to suspect that the
   *  column state has been changed.  This could be because there was no
   *  persisted state so we figured out a default one and want to save it.
   *  Otherwise this should be because the user explicitly changed up the column
   *  configurations.  You should not call this willy-nilly.
   *
   * @param aState State to persist.
   */
  _persistColumnStates(aState) {
    if (this.view.isSynthetic) {
      let syntheticView = this.view._syntheticView;
      if ("setPersistedSetting" in syntheticView) {
        syntheticView.setPersistedSetting("columns", aState);
      }
      return;
    }

    if (!this.view.displayedFolder || !this.view.displayedFolder.msgDatabase) {
      return;
    }

    let msgDatabase = this.view.displayedFolder.msgDatabase;
    let dbFolderInfo = msgDatabase.dBFolderInfo;
    dbFolderInfo.setCharProperty(
      this.PERSISTED_COLUMN_PROPERTY_NAME,
      JSON.stringify(aState)
    );
    msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
  },

  /**
   * Let us know that the state of the columns has changed.  This is either due
   *  to a re-ordering or hidden-ness being toggled.
   *
   * This method should only be called on (the active) gFolderDisplay.
   */
  hintColumnsChanged() {
    // ignore this if we are the ones doing things
    if (this._touchingColumns) {
      return;
    }
    this._persistColumnStates(this.getColumnStates());
  },

  /**
   * Either inherit the column state of another folder or use heuristics to
   *  figure out the best column state for the current folder.
   */
  _getDefaultColumnsForCurrentFolder(aDoNotInherit) {
    // If the view is synthetic, try asking it for its default columns. If it
    // fails, just return nothing, since most synthetic views don't care about
    // columns anyway.
    if (this.view.isSynthetic) {
      if ("getDefaultSetting" in this.view._syntheticView) {
        return this.view._syntheticView.getDefaultSetting("columns");
      }
      return {};
    }

    // do not inherit from the inbox if:
    // - It's an outgoing folder; these have a different use-case and there
    //    should be a small number of these, so it's okay to have no defaults.
    // - It's a virtual folder (single or multi-folder backed).  Who knows what
    //    the intent of the user is in this case.  This should also be bounded
    //    in number and our default heuristics should be pretty good.
    // - It's a multiple folder; this is either a search view (which has no
    //   displayed folder) or a virtual folder (which we eliminated above).
    // - News folders.  There is no inbox so there's nothing to inherit from.
    //    (Although we could try and see if they have opened any other news
    //    folders in the same account.  But it's not all that important to us.)
    // - It's an inbox!
    let doNotInherit =
      aDoNotInherit ||
      this.view.isOutgoingFolder ||
      this.view.isVirtual ||
      this.view.isMultiFolder ||
      this.view.isNewsFolder ||
      this.displayedFolder.getFlag(Ci.nsMsgFolderFlags.Inbox);

    // Try and grab the inbox for this account's settings.  we may not be able
    //  to, in which case we just won't inherit.  (It ends up the same since the
    //  inbox is obviously not customized in this case.)
    if (!doNotInherit) {
      let inboxFolder = this.displayedFolder.rootFolder.getFolderWithFlags(
        Ci.nsMsgFolderFlags.Inbox
      );
      if (inboxFolder) {
        let state = this._depersistColumnStatesFromDbFolderInfo(
          inboxFolder.msgDatabase.dBFolderInfo
        );
        // inbox message databases don't get closed as a matter of policy.

        if (state) {
          return state;
        }
      }
    }

    // if we are still here, use the defaults and helper functions
    let state = {};
    for (let colId of this.DEFAULT_COLUMNS) {
      let shouldShowColumn = true;
      if (colId in this.COLUMN_DEFAULT_TESTERS) {
        // This is potentially going to be used by extensions; avoid them
        //  killing us.
        try {
          shouldShowColumn = this.COLUMN_DEFAULT_TESTERS[colId](this.view);
        } catch (ex) {
          shouldShowColumn = false;
          console.error(ex);
        }
      }
      state[colId] = { visible: shouldShowColumn };
    }
    return state;
  },

  /**
   * Is setColumnStates messing with the columns' DOM?  This is used by
   *  hintColumnsChanged to avoid wasteful state persistence.
   */
  _touchingColumns: false,

  /**
   * Set the column states of this FolderDisplay to the provided state.
   *
   * @param aColumnStates an object of the form described on
   *     |_savedColumnStates|.  If ordinal attributes are omitted then no
   *     re-ordering will be performed.  This is intentional, but potentially a
   *     bad idea.  (Right now only gloda search underspecifies ordinals.)
   * @param [aPersistChanges=false] Should we persist the changes to the view?
   *     This only has an effect if we are active.
   *
   * @public
   */
  setColumnStates(aColumnStates, aPersistChanges) {
    // If we are not active, just overwrite our current state with the provided
    //  state and bail.
    if (!this._active) {
      this._savedColumnStates = aColumnStates;
      return;
    }

    this._touchingColumns = true;

    try {
      let cols = document.getElementById("threadCols");
      let colChildren = cols.children;

      for (let iKid = 0; iKid < colChildren.length; iKid++) {
        let colChild = colChildren[iKid];
        if (colChild == null) {
          continue;
        }

        // We only care about treecols.  The splitters do not need to be marked
        //  hidden or un-hidden.
        if (colChild.tagName == "treecol") {
          // if it doesn't have preserved state it should be hidden
          let shouldBeHidden = true;
          // restore state
          if (colChild.id in aColumnStates) {
            let colState = aColumnStates[colChild.id];
            if ("visible" in colState) {
              shouldBeHidden = !colState.visible;
            }
            if ("ordinal" in colState && colChild.ordinal != colState.ordinal) {
              colChild.ordinal = colState.ordinal;
            }
          }
          let isHidden = colChild.hidden;
          if (isHidden != shouldBeHidden) {
            if (shouldBeHidden) {
              colChild.setAttribute("hidden", "true");
            } else {
              colChild.removeAttribute("hidden");
            }
          }
        }
      }
    } finally {
      this._touchingColumns = false;
    }

    if (aPersistChanges) {
      this.hintColumnsChanged();
    }
  },

  /**
   * A dictionary that maps column ids to dictionaries where each dictionary
   *  has the following fields:
   * - visible: Is the column visible.
   * - ordinal: The 1-based XUL 'ordinal' value assigned to the column.  This
   *    corresponds to the position but is not something you want to manipulate.
   *    See the documentation in _saveColumnStates for more information.
   */
  _savedColumnStates: null,

  /**
   * Return a dictionary in the form of |_savedColumnStates| representing the
   *  current column states.
   *
   * @public
   */
  getColumnStates() {
    if (!this._active) {
      return this._savedColumnStates;
    }

    let columnStates = {};

    let cols = document.getElementById("threadCols");
    let colChildren = cols.children;
    for (let iKid = 0; iKid < colChildren.length; iKid++) {
      let colChild = colChildren[iKid];
      if (colChild.tagName != "treecol") {
        continue;
      }
      columnStates[colChild.id] = {
        visible: !colChild.hidden,
        ordinal: colChild.ordinal,
      };
    }

    return columnStates;
  },

  /**
   * For now, just save the visible columns into a dictionary for use in a
   *  subsequent call to |setColumnStates|.
   */
  _saveColumnStates() {
    // In the actual TreeColumn, the index property indicates the column
    // number. This column number is a 0-based index with no gaps; it only
    // increments the number each time it sees a column.
    // However, this is subservient to the 'ordinal' property which
    // defines the _apparent content sequence_ provided by GetNextSibling.
    // The underlying content ordering is still the same, which is how
    // _ensureColumnOrder() can reset things to their XUL definition sequence.
    // The 'ordinal' stuff works because nsBoxFrame::RelayoutChildAtOrdinal
    // messes with the sibling relationship.
    // Ordinals are 1-based. _ensureColumnOrder() apparently is dumb and does
    // not know this, although the ordering is relative so it doesn't actually
    // matter. The annoying splitters do have ordinals, and live between
    // tree columns. The splitters adjacent to a tree column do not need to
    // have any 'ordinal' relationship, although it would appear user activity
    // tends to move them around in a predictable fashion with oddness involved
    // at the edges.
    // Changes to the ordinal attribute should take immediate effect in terms of
    // sibling relationship, but will merely invalidate the columns rather than
    // cause a re-computation of column relationships every time.
    // _ensureColumnOrder() invalidates the tree when it is done re-ordering;
    // I'm not sure that's entirely necessary...
    this._savedColumnStates = this.getColumnStates();
  },

  /**
   * Restores the visible columns saved by |_saveColumnStates|.
   */
  _restoreColumnStates() {
    if (this._savedColumnStates) {
      this.setColumnStates(this._savedColumnStates);
      this._savedColumnStates = null;
    }
  },
  // @}

  /**
   * @name What To Display
   * @protected
   */
  // @{
  showFolderUri(aFolderURI) {
    return this.show(MailUtils.getExistingFolder(aFolderURI));
  },

  /**
   * Invoked by showFolder when it turns out the folder is in fact a server.
   *
   * @private
   */
  _showServer() {
    // currently nothing to do.  makeActive handles everything for us (because
    //  what is displayed needs to be re-asserted each time we are activated
    //  too.)
  },

  /**
   * Select a folder for display.
   *
   * @param aFolder The nsIMsgDBFolder to display.
   */
  show(aFolder) {
    if (aFolder == null) {
      this._nonViewFolder = null;
      this.view.close();
    } else if (aFolder instanceof Ci.nsIMsgFolder) {
      if (aFolder.isServer) {
        this._nonViewFolder = aFolder;
        this._showServer();
        this.view.close();
        // A server is fully loaded immediately, for now.  (When we have the
        //  account summary, we might want to change this to wait for the page
        //  load to complete.)
        this._allMessagesLoaded = true;
      } else {
        this._nonViewFolder = null;
        this.view.open(aFolder);
      }
    } else {
      // it must be a synthetic view
      this.view.openSynthetic(aFolder);
    }
    if (this._active) {
      this.makeActive();
    }
  },

  /**
   * Clone an existing view wrapper as the basis for our display.
   */
  cloneView(aViewWrapper) {
    this.view = aViewWrapper.clone(this);
    // generate a view created notification; this will cause us to do the right
    //  thing in terms of associating the view with the tree and such.
    this.onCreatedView();
    if (this._active) {
      this.makeActive();
    }
  },

  /**
   * Close resources associated with the currently displayed folder because you
   *  no longer care about this FolderDisplayWidget.
   */
  close() {
    // Mark ourselves as inactive without doing any of the hard work of becoming
    //  inactive.  This saves us from trying to update things as they go away.
    this._active = false;

    this.view.close();
    this.messenger.setWindow(null, null);
    this.messenger = null;
    this._fakeTree.remove();
    this._fakeTree = null;
    this._fakeTreeSelection = null;
  },
  // @}

  /*   ===============================   */
  /* ===== IDBViewWrapper Listener ===== */
  /*   ===============================   */

  /**
   * @name IDBViewWrapperListener Interface
   * @private
   */
  // @{

  /**
   * @returns true if the mail view picker is visible.  This affects whether the
   *     DBViewWrapper will actually use the persisted mail view or not.
   */
  get shouldUseMailViews() {
    return ViewPickerBinding.isVisible;
  },

  /**
   * Let the viewWrapper know if we should defer message display because we
   *  want the user to connect to the server first so password authentication
   *  can occur.
   *
   * @returns true if the folder should be shown immediately, false if we should
   *     wait for updateFolder to complete.
   */
  get shouldDeferMessageDisplayUntilAfterServerConnect() {
    let passwordPromptRequired = false;

    if (Services.prefs.getBoolPref("mail.password_protect_local_cache")) {
      passwordPromptRequired =
        this.view.displayedFolder.server.passwordPromptRequired;
    }

    return passwordPromptRequired;
  },

  /**
   * Let the viewWrapper know if it should mark the messages read when leaving
   *  the provided folder.
   *
   * @returns true if the preference is set for the folder's server type.
   */
  shouldMarkMessagesReadOnLeavingFolder(aMsgFolder) {
    return Services.prefs.getBoolPref(
      "mailnews.mark_message_read." + aMsgFolder.server.type
    );
  },

  /**
   * The view wrapper tells us when it starts loading a folder, and we set the
   *  cursor busy.  Setting the cursor busy on a per-tab basis is us being
   *  nice to the future. Loading a folder is a blocking operation that is going
   *  to make us unresponsive and accordingly make it very hard for the user to
   *  change tabs.
   */
  onFolderLoading(aFolderLoading) {
    FolderDisplayListenerManager._fireListeners("onFolderLoading", [
      this,
      aFolderLoading,
    ]);
  },

  /**
   * The view wrapper tells us when a search is active, and we mark the tab as
   *  thinking so the user knows something is happening.  'Searching' in this
   *  case is more than just a user-initiated search.  Virtual folders / saved
   *  searches, mail views, plus the more obvious quick search are all based off
   *  of searches and we will receive a notification for them.
   */
  onSearching(aIsSearching) {
    FolderDisplayListenerManager._fireListeners("onSearching", [
      this,
      aIsSearching,
    ]);
  },

  /**
   * Things we do on creating a view:
   * - notify the observer service so that custom column handler providers can
   *   add their custom columns to our view.
   */
  onCreatedView() {
    // All of our messages are not displayed if the view was just created.  We
    //  will get an onMessagesLoaded(true) nearly immediately if this is a local
    //  folder where view creation is synonymous with having all messages.
    this._allMessagesLoaded = false;

    FolderDisplayListenerManager._fireListeners("onCreatedView", [this]);

    this._notifyWhenActive(this._activeCreatedView);
  },
  _activeCreatedView() {
    gDBView = this.view.dbView; // eslint-disable-line no-global-assign

    // A change in view may result in changes to sorts, the view menu, etc.
    // Do this before we 'reroot' the dbview.
    this._updateThreadDisplay();

    // this creates a new selection object for the view.
    if (this.tree) {
      this.tree.view = this.view.dbView;
    }

    FolderDisplayListenerManager._fireListeners("onActiveCreatedView", [this]);

    // The data payload used to be viewType + ":" + viewFlags.  We no longer
    //  do this because we already have the implied contract that gDBView is
    //  valid at the time we generate the notification.  In such a case, you
    //  can easily get that information from the gDBView.  (The documentation
    //  on creating a custom column assumes gDBView.)
    Services.obs.notifyObservers(this.displayedFolder, "MsgCreateDBView");
  },

  /**
   * If our view is being destroyed and it is coming back, we want to save the
   *  current selection so we can restore it when the view comes back.
   */
  onDestroyingView(aFolderIsComingBack) {
    // try and persist the selection's content if we can
    if (this._active) {
      // If saving the selection throws an exception, we still want continue
      // destroying the view. Saving the selection can fail if an underlying
      // local folder has been compacted, invalidating the message keys.
      // See bug 536676 for more info.
      try {
        // If a new selection is coming up, there's no point in trying to
        // persist any selections.
        if (aFolderIsComingBack && !this._aboutToSelectMessage) {
          this._saveSelection();
        } else {
          this._clearSavedSelection();
        }
      } catch (ex) {
        console.error(ex);
      }
      gDBView = null; // eslint-disable-line no-global-assign
    }

    FolderDisplayListenerManager._fireListeners("onDestroyingView", [
      this,
      aFolderIsComingBack,
    ]);

    // if we have no view, no messages could be loaded.
    this._allMessagesLoaded = false;

    // but the actual tree view selection (based on view indices) is a goner no
    //  matter what, make everyone forget.
    this.view.dbView.selection = null;
    this._savedFirstVisibleRow = null;
    this._nextViewIndexAfterDelete = null;
    // although the move may still be active, its relation to the view is moot.
    this._massMoveActive = false;

    // Anything pending needs to get cleared out; the new view and its related
    //  events will re-schedule anything required or simply run it when it
    //  has its initial call to makeActive compelled.
    this._notificationsPendingActivation = [];
  },

  /**
   * Restore persisted information about what columns to display for the folder.
   *  If we have no persisted information, we leave/set _savedColumnStates null.
   *  The column states will be set to default values in onDisplayingFolder in
   *  that case.
   */
  onLoadingFolder(aDbFolderInfo) {
    this._savedColumnStates =
      this._depersistColumnStatesFromDbFolderInfo(aDbFolderInfo);

    FolderDisplayListenerManager._fireListeners("onLoadingFolder", [
      this,
      aDbFolderInfo,
    ]);
  },

  /**
   * We are entering the folder for display:
   * - set the header cache size.
   * - Setup the columns if we did not already depersist in |onLoadingFolder|.
   */
  onDisplayingFolder() {
    let displayedFolder = this.view.displayedFolder;
    let msgDatabase = displayedFolder && displayedFolder.msgDatabase;
    if (msgDatabase) {
      msgDatabase.resetHdrCacheSize(this.PERF_HEADER_CACHE_SIZE);
    }

    // makeActive will restore the folder state
    if (!this._savedColumnStates) {
      if (
        this.view.isSynthetic &&
        "getPersistedSetting" in this.view._syntheticView
      ) {
        let columns = this.view._syntheticView.getPersistedSetting("columns");
        this._savedColumnStates = columns;
      } else {
        // get the default for this folder
        this._savedColumnStates = this._getDefaultColumnsForCurrentFolder();
        // and save it so it doesn't wiggle if the inbox/prototype changes
        this._persistColumnStates(this._savedColumnStates);
      }
    }

    FolderDisplayListenerManager._fireListeners("onDisplayingFolder", [this]);

    if (this.active) {
      this.makeActive();
    }
  },

  /**
   * Notification from DBViewWrapper that it is closing the folder.  This can
   *  happen for reasons other than our own 'close' method closing the view.
   *  For example, user deletion of the folder or underlying folder closes it.
   */
  onLeavingFolder() {
    FolderDisplayListenerManager._fireListeners("onLeavingFolder", [this]);

    // Keep the msgWindow's openFolder up-to-date; it powers nsMessenger's
    //  concept of history so that it can bring you back to the actual folder
    //  you were looking at, rather than just the underlying folder.
    if (this._active) {
      msgWindow.openFolder = null;
    }
  },

  /**
   * Indicates whether we are done loading the messages that should be in this
   *  folder.  This is being surfaced for testing purposes, but could be useful
   *  to other code as well.  But don't poll this property; ask for an event
   *  that you can hook.
   */
  get allMessagesLoaded() {
    return this._allMessagesLoaded;
  },

  /**
   * Things to do once some or all the messages that should show up in a folder
   *  have shown up.  For a real folder, this happens when the folder is
   *  entered. For a virtual folder, this happens when the search completes.
   *
   * What we do:
   * - Any scrolling required!
   */
  onMessagesLoaded(aAll) {
    this._allMessagesLoaded = aAll;

    FolderDisplayListenerManager._fireListeners("onMessagesLoaded", [
      this,
      aAll,
    ]);

    this._notifyWhenActive(this._activeMessagesLoaded);
  },
  _activeMessagesLoaded() {
    FolderDisplayListenerManager._fireListeners("onActiveMessagesLoaded", [
      this,
    ]);

    // - if a selectMessage's coming up, get out of here
    if (this._aboutToSelectMessage) {
      return;
    }

    // - restore user's last expand/collapse choice.
    this.restoreThreadState();

    // - restore selection
    // Attempt to restore the selection (if we saved it because the view was
    //  being destroyed or otherwise manipulated in a fashion that the normal
    //  nsTreeSelection would be unable to handle.)
    if (this._restoreSelection()) {
      this.ensureRowIsVisible(this.view.dbView.viewIndexForFirstSelectedMsg);
      return;
    }

    // - pending navigation from pushNavigation (probably spacebar triggered)
    // Need to have all messages loaded first.
    if (this._pendingNavigation) {
      // Move it to a local and clear the state in case something bad happens.
      //  (We don't want to swallow the exception.)
      let pendingNavigation = this._pendingNavigation;
      this._pendingNavigation = null;
      this.navigate.apply(this, pendingNavigation);
      return;
    }

    // - if something's already selected (e.g. in a message tab), scroll to the
    //   first selected message and get out
    if (this.view.dbView.numSelected > 0) {
      this.ensureRowIsVisible(this.view.dbView.viewIndexForFirstSelectedMsg);
      return;
    }

    // - new messages
    // if configured to scroll to new messages, try that
    if (
      Services.prefs.getBoolPref("mailnews.scroll_to_new_message") &&
      this.navigate(Ci.nsMsgNavigationType.firstNew, /* select */ false)
    ) {
      return;
    }

    // - last selected message
    // if configured to load the last selected message (this is currently more
    //  persistent than our saveSelection/restoreSelection stuff), and the view
    //  is backed by a single underlying folder (the only way having just a
    //  message key works out), try that
    if (
      Services.prefs.getBoolPref("mailnews.remember_selected_message") &&
      this.view.isSingleFolder &&
      this.view.displayedFolder
    ) {
      // use the displayed folder; nsMsgDBView goes to the effort to save the
      //  state to the viewFolder, so this is the correct course of action.
      let lastLoadedMessageKey = this.view.displayedFolder.lastMessageLoaded;
      if (lastLoadedMessageKey != nsMsgKey_None) {
        this.view.dbView.selectMsgByKey(lastLoadedMessageKey);
        // The message key may not be present in the view for a variety of
        //  reasons.  Beyond message deletion, it simply may not match the
        //  active mail view or quick search, for example.
        if (this.view.dbView.numSelected > 0) {
          this.ensureRowIsVisible(
            this.view.dbView.viewIndexForFirstSelectedMsg
          );
          return;
        }
      }
    }

    // - towards the newest messages, but don't select
    if (
      this.view.isSortedAscending &&
      this.view.sortImpliesTemporalOrdering &&
      this.navigate(Ci.nsMsgNavigationType.lastMessage, /* select */ false)
    ) {
      return;
    }

    // - to the top, the coliseum
    this.ensureRowIsVisible(0);
  },

  /**
   * The DBViewWrapper tells us when someone (possibly the wrapper itself)
   *  changes the active mail view so that we can kick the UI to update.
   */
  onMailViewChanged() {
    // only do this if we're currently active.  no need to queue it because we
    //  always update the mail view whenever we are made active.
    if (this.active) {
      // you cannot cancel a view change!
      window.dispatchEvent(
        new Event("MailViewChanged", { bubbles: false, cancelable: false })
      );
    }
  },

  /**
   * Just the sort or threading was changed, without changing other things.  We
   *  will not get this notification if the view was re-created, for example.
   */
  onSortChanged() {
    if (this.active) {
      UpdateSortIndicators(
        this.view.primarySortType,
        this.view.primarySortOrder
      );
    }

    FolderDisplayListenerManager._fireListeners("onSortChanged", [this]);
  },

  /**
   * Messages (that may have been displayed) have been removed; this may impact
   * our message selection. We might know it's coming; if we do then
   * this._nextViewIndexAfterDelete should know what view index to select next.
   * For the imap mark-as-deleted we won't know beforehand.
   */
  onMessagesRemoved() {
    FolderDisplayListenerManager._fireListeners("onMessagesRemoved", [this]);

    this._deleteInProgress = false;

    // - we saw this coming
    let rowCount = this.view.dbView.rowCount;
    if (!this._massMoveActive && this._nextViewIndexAfterDelete != null) {
      // adjust the index if it is after the last row...
      // (this can happen if the "mail.delete_matches_sort_order" pref is not
      //  set and the message is the last message in the view.)
      if (this._nextViewIndexAfterDelete >= rowCount) {
        this._nextViewIndexAfterDelete = rowCount - 1;
      }
      // just select the index and get on with our lives
      this.selectViewIndex(this._nextViewIndexAfterDelete);
      this._nextViewIndexAfterDelete = null;
      return;
    }

    // - we didn't see it coming

    // A deletion happened to our folder.
    let treeSelection = this.treeSelection;
    // we can't fix the selection if we have no selection
    if (!treeSelection) {
      return;
    }

    // For reasons unknown (but theoretically knowable), sometimes the selection
    //  object will be invalid.  At least, I've reliably seen a selection of
    //  [0, 0] with 0 rows.  If that happens, we need to fix up the selection
    //  here.
    if (rowCount == 0 && treeSelection.count) {
      // nsTreeSelection doesn't generate an event if we use clearRange, so use
      //  that to avoid spurious events, given that we are going to definitely
      //  trigger a change notification below.
      treeSelection.clearRange(0, 0);
    }

    // Check if we now no longer have a selection, but we had exactly one
    //  message selected previously.  If we did, then try and do some
    //  'persistence of having a thing selected'.
    if (
      treeSelection.count == 0 &&
      this._mostRecentSelectionCounts.length > 1 &&
      this._mostRecentSelectionCounts[1] == 1 &&
      this._mostRecentCurrentIndices[1] != -1
    ) {
      let targetIndex = this._mostRecentCurrentIndices[1];
      if (targetIndex >= rowCount) {
        targetIndex = rowCount - 1;
      }
      this.selectViewIndex(targetIndex);
      return;
    }

    // Otherwise, just tell the view that things have changed so it can update
    //  itself to the new state of things.
    // tell the view that things have changed so it can update itself suitably.
    if (this.view.dbView) {
      this.view.dbView.selectionChanged();
    }
  },

  /**
   * Messages were not actually removed, but we were expecting that they would
   *  be.  Clean-up what onMessagesRemoved would have cleaned up, namely the
   *  next view index to select.
   */
  onMessageRemovalFailed() {
    this._nextViewIndexAfterDelete = null;
    FolderDisplayListenerManager._fireListeners("onMessagesRemovalFailed", [
      this,
    ]);
  },

  /**
   * Update the status bar to reflect our exciting message counts.
   */
  onMessageCountsChanged() {},
  // @}
  /* ===== End IDBViewWrapperListener ===== */

  /*   ==================================   */
  /* ===== nsIMsgDBViewCommandUpdater ===== */
  /*   ==================================   */

  /**
   * @name nsIMsgDBViewCommandUpdater Interface
   * @private
   */
  // @{

  /**
   * This gets called when the selection changes AND !suppressCommandUpdating
   *  AND (we're not removing a row OR we are now out of rows).
   * In response, we update the toolbar.
   */
  updateCommandStatus() {},

  /**
   * This gets called by nsMsgDBView::UpdateDisplayMessage following a call
   *  to nsIMessenger.OpenURL to kick off message display OR (UDM gets called)
   *  by nsMsgDBView::SelectionChanged in lieu of loading the message because
   *  mSupressMsgDisplay.
   * In other words, we get notified immediately after the process of displaying
   *  a message triggered by the nsMsgDBView happens.  We get some arguments
   *  that are display optimizations for historical reasons (as usual).
   *
   * Things this makes us want to do:
   * - Set the tab title, perhaps.  (If we are a message display.)
   * - Update message counts, because things might have changed, why not.
   * - Update some toolbar buttons, why not.
   *
   * @param aFolder The display/view folder, as opposed to the backing folder.
   * @param aSubject The subject with "Re: " if it's got one, which makes it
   *     notably different from just directly accessing the message header's
   *     subject.
   * @param aKeywords The keywords, which roughly translates to message tags.
   */
  displayMessageChanged(aFolder, aSubject, aKeywords) {},

  /**
   * This gets called as a hint that the currently selected message is junk and
   *  said junked message is going to be moved out of the current folder, or
   *  right before a header is removed from the db view.  The legacy behaviour
   *  is to retrieve the msgToSelectAfterDelete attribute off the db view,
   *  stashing it for benefit of the code that gets called when a message
   *  move/deletion is completed so that we can trigger its display.
   */
  updateNextMessageAfterDelete() {
    this.hintAboutToDeleteMessages();
  },

  /**
   * The most recent currentIndexes on the selection (from the last time
   *  summarizeSelection got called).  We use this in onMessagesRemoved if
   *  we get an unexpected notification.
   * We keep a maximum of 2 entries in this list.
   */
  _mostRecentCurrentIndices: undefined, // initialized in constructor
  /**
   * The most recent counts on the selection (from the last time
   *  summarizeSelection got called).  We use this in onMessagesRemoved if
   *  we get an unexpected notification.
   * We keep a maximum of 2 entries in this list.
   */
  _mostRecentSelectionCounts: undefined, // initialized in constructor

  /**
   * Always called by the db view when the selection changes in
   *  SelectionChanged.  This event will come after the notification to
   *  displayMessageChanged (if one happens), and before the notification to
   *  updateCommandStatus (if one happens).
   */
  summarizeSelection() {
    // save the current index off in case the selection gets deleted out from
    //  under us and we want to have persistence of actually-having-something
    //  selected.
    let treeSelection = this.treeSelection;
    if (treeSelection) {
      this._mostRecentCurrentIndices.unshift(treeSelection.currentIndex);
      this._mostRecentCurrentIndices.splice(2);
      this._mostRecentSelectionCounts.unshift(treeSelection.count);
      this._mostRecentSelectionCounts.splice(2);
    }
  },
  // @}
  /* ===== End nsIMsgDBViewCommandUpdater ===== */

  /* ===== Hints from the command infrastructure ===== */
  /**
   * @name Command Infrastructure Hints
   * @protected
   */
  // @{

  /**
   * doCommand helps us out by telling us when it is telling the view to delete
   *  some messages.  Ideally it should go through us / the DB View Wrapper to
   *  kick off the delete in the first place, but that's a thread I don't want
   *  to pull on right now.
   * We use this hint to figure out the next message to display once the
   *  deletion completes.  We do this before the deletion happens because the
   *  selection is probably going away (except in the IMAP delete model), and it
   *  might be too late to figure this out after the deletion happens.
   * Our automated complement (that calls us) is updateNextMessageAfterDelete.
   */
  hintAboutToDeleteMessages() {
    this._deleteInProgress = true;
    // save the value, even if it is nsMsgViewIndex_None.
    this._nextViewIndexAfterDelete = this.view.dbView.msgToSelectAfterDelete;
  },

  /**
   * The archive code tells us when it is starting to archive messages.  This
   *  is different from hinting about deletion because it will also tell us
   *  when it has completed its mass move.
   * The UI goal is that we do not immediately jump beyond the selected messages
   *  to the next message until all of the selected messages have been
   *  processed (moved).  Ideally we would also do this when deleting messages
   *  from a multiple-folder backed message view, but we don't know when the
   *  last job completes in that case (whereas in this case we do because of the
   *  call to hintMassMoveCompleted.)
   */
  hintMassMoveStarting() {
    this.hintAboutToDeleteMessages();
    this._massMoveActive = true;
  },

  /**
   * The archival has completed, we can finally let onMessagseRemoved run to
   *  completion.
   */
  hintMassMoveCompleted() {
    this._massMoveActive = false;
    this.onMessagesRemoved();
  },

  /**
   * When a right-click on the thread pane is going to alter our selection, we
   *  get this notification (currently from |ChangeSelectionWithoutContentLoad|
   *  in threadPane.js), which lets us save our state.
   * This ends one of two ways: we get made inactive because a new tab popped up
   *  or we get a call to |hintRightClickSelectionPerturbationDone|.
   *
   * Ideally, we could just save off our current nsITreeSelection and restore it
   *  when this is all over.  This assumption would rely on the underlying view
   *  not having any changes to its rows before we restore the selection.  I am
   *  not confident we can rule out background processes making changes, plus
   *  the right-click itself may mutate the view (although we could try and get
   *  it to restore the selection before it gets to the mutation part).  Our
   *  only way to resolve this would be to create a 'tee' like fake selection
   *  that would proxy view change notifications to both sets of selections.
   *  That is hard.
   * So we just use the existing _saveSelection/_restoreSelection mechanism
   *  which is potentially very costly.
   */
  hintRightClickPerturbingSelection() {
    this._saveSelection();
  },

  /**
   * When a right-click on the thread pane altered our selection (which we
   *  should have received a call to |hintRightClickPerturbingSelection| for),
   *  we should receive this notification from
   *  |RestoreSelectionWithoutContentLoad| when it wants to put things back.
   */
  hintRightClickSelectionPerturbationDone() {
    this._restoreSelection();
  },
  // @}
  /* ===== End hints from the command infrastructure ==== */

  _updateThreadDisplay() {
    if (this.active) {
      if (this.view.dbView) {
        UpdateSortIndicators(
          this.view.dbView.sortType,
          this.view.dbView.sortOrder
        );
        SetNewsFolderColumns();
        UpdateSelectCol();
      }
    }
  },

  /**
   * Update the UI display apart from the thread tree because the folder being
   *  displayed has changed.  This can be the result of changing the folder in
   *  this FolderDisplayWidget, or because this FolderDisplayWidget is being
   *  made active.  _updateThreadDisplay handles the parts of the thread tree
   *  that need updating.
   */
  _updateContextDisplay() {
    if (this.active) {
      UpdateStatusQuota(this.displayedFolder);

      // - mail view combo-box.
      this.onMailViewChanged();
    }
  },

  /**
   * @name Activation Control
   * @protected
   */
  // @{

  /**
   * Run the provided notification function right now if we are 'active' (the
   *  currently displayed tab), otherwise queue it to be run when we become
   *  active.  We do this because our tabbing model uses multiplexed (reused)
   *  widgets, and extensions likewise depend on these global/singleton things.
   * If the requested notification function is already queued, it will not be
   *  added a second time, and the original call ordering will be maintained.
   *  If a new call ordering is required, the list of notifications should
   *  probably be reset by the 'big bang' event (new view creation?).
   */
  _notifyWhenActive(aNotificationFunc) {
    if (this._active) {
      aNotificationFunc.call(this);
    } else if (
      !this._notificationsPendingActivation.includes(aNotificationFunc)
    ) {
      this._notificationsPendingActivation.push(aNotificationFunc);
    }
  },

  /**
   * Some notifications cannot run while the FolderDisplayWidget is inactive
   *  (presumbly because it is in a background tab).  We accumulate those in
   *  _notificationsPendingActivation and then this method runs them when we
   *  become active again.
   */
  _runNotificationsPendingActivation() {
    if (!this._notificationsPendingActivation.length) {
      return;
    }

    let pendingNotifications = this._notificationsPendingActivation;
    this._notificationsPendingActivation = [];
    for (let notif of pendingNotifications) {
      notif.call(this);
    }
  },

  // This is not guaranteed to be up to date if the folder display is active
  _folderPaneVisible: null,

  /**
   * Whether the folder pane is visible. When we're inactive, we stash the value
   * in |this._folderPaneVisible|.
   */
  get folderPaneVisible() {
    // Early return if the user wants to use Thunderbird without an email
    // account and no account is configured.
    if (
      Services.prefs.getBoolPref("app.use_without_mail_account", false) &&
      !MailServices.accounts.accounts.length
    ) {
      return false;
    }

    if (this._active) {
      let folderPaneBox = document.getElementById("folderPaneBox");
      if (folderPaneBox) {
        return !folderPaneBox.collapsed;
      }
    } else {
      return this._folderPaneVisible;
    }

    return null;
  },

  /**
   * Sets the visibility of the folder pane. This should reflect reality and
   * not define it (for active tabs at least).
   */
  set folderPaneVisible(aVisible) {
    this._folderPaneVisible = aVisible;
  },

  get active() {
    return this._active;
  },

  /**
   * Make this FolderDisplayWidget the 'active' widget by updating globals and
   *  linking us up to the UI widgets.  This is intended for use by the tabbing
   *  logic.
   */
  makeActive(aWasInactive) {
    let wasInactive = !this._active;

    // -- globals
    // update per-tab globals that we own
    gFolderDisplay = this; // eslint-disable-line no-global-assign
    gDBView = this.view.dbView; // eslint-disable-line no-global-assign
    messenger = this.messenger; // eslint-disable-line no-global-assign

    // update singleton globals' state
    msgWindow.openFolder = this.view.displayedFolder;

    this._active = true;
    this._runNotificationsPendingActivation();

    // Make sure we get rid of this._fakeTreeSelection, whether we use it below
    // or not.
    let fakeTreeSelection = this._fakeTreeSelection;
    this._fakeTreeSelection = null;

    FolderDisplayListenerManager._fireListeners("onMakeActive", [
      this,
      aWasInactive,
    ]);

    // -- UI

    // thread pane if we have a db view
    if (this.view.dbView) {
      // Make sure said thread pane is visible.  If we do this after we re-root
      //  the tree, the thread pane may not actually replace the account central
      //  pane.  Concerning...
      this._showThreadPane();

      // some things only need to happen if we are transitioning from inactive
      //  to active
      if (wasInactive) {
        if (this.tree) {
          // We might have assigned our JS tree selection to
          //  this.view.dbView.selection back in _hookUpFakeTree. If we've
          //  done so, null the selection out so that the line after this
          //  causes a real selection to be created.
          // If we haven't done so, we're fine as selection would be null here
          //  anyway. (The fake tree selection should persist only till the
          //  first time the tab is switched to.)
          if (fakeTreeSelection) {
            this.view.dbView.selection = null;
          }

          // Setting the 'view' attribute on treeBox results in the following
          //  effective calls, noting that in makeInactive we made sure to null
          //  out its view so that it won't try and clean up any views or their
          //  selections.  (The actual actions happen in
          //  nsTreeBodyFrame::SetView)
          // - this.view.dbView.selection.tree = this.tree
          // - this.view.dbView.setTree(this.tree)
          // - this.tree.view = this.view.dbView (in
          //   nsTreeBodyObject::SetView)
          this.tree.view = this.view.dbView;

          if (fakeTreeSelection) {
            fakeTreeSelection.duplicateSelection(this.view.dbView.selection);
          }
          if (this._savedFirstVisibleRow != null) {
            this.tree.scrollToRow(this._savedFirstVisibleRow);
          }
        }
      }

      // Always restore the column state if we have persisted state.  We restore
      //  state on folder entry, in which case we were probably not inactive.
      this._restoreColumnStates();

      // update the columns and such that live inside the thread pane
      this._updateThreadDisplay();
    }

    this._updateContextDisplay();
  },

  /**
   * Cause the displayBox to display the thread pane.
   */
  _showThreadPane() {
    document.getElementById("accountCentralBox").collapsed = true;
    document.getElementById("threadPaneBox").collapsed = false;
  },

  /**
   * Cause the displayBox to display the (preference configurable) account
   *  central page.
   */
  _showAccountCentral() {
    if (!this.displayedFolder && MailServices.accounts.accounts.length > 0) {
      // If we have any accounts set up, but no folder is selected yet,
      // we expect another selection event to come when session restore finishes.
      // Until then, do nothing.
      return;
    }
    document.getElementById("accountCentralBox").collapsed = false;
    document.getElementById("threadPaneBox").collapsed = true;

    // Prevent a second load if necessary.
    let loadURL =
      "chrome://messenger/content/msgAccountCentral.xhtml" +
      (this.displayedFolder
        ? "?folderURI=" + encodeURIComponent(this.displayedFolder.URI)
        : "");
    if (window.frames.accountCentralPane.location.href != loadURL) {
      window.frames.accountCentralPane.location.href = loadURL;
    }
  },

  /**
   * Call this when the tab using us is being hidden.
   */
  makeInactive() {
    // - things to do before we mark ourselves inactive (because they depend on
    //   us being active)

    // getColumnStates returns _savedColumnStates when we are inactive (and is
    //  used by _saveColumnStates) so we must do this before marking inactive.
    this._saveColumnStates();

    // - mark us inactive
    this._active = false;

    // - (everything after this point doesn't care that we are marked inactive)
    // save the folder pane's state always
    this._folderPaneVisible =
      !document.getElementById("folderPaneBox").collapsed;

    if (this.view.dbView) {
      if (this.tree) {
        this._savedFirstVisibleRow = this.tree.getFirstVisibleRow();
      }

      // save the message pane's state only when it is potentially visible
      this.messagePaneCollapsed = document.getElementById(
        "messagepaneboxwrapper"
      ).collapsed;

      this.hookUpFakeTree(true);
    }
  },
  // @}

  /**
   * Called when we want to "disable" the real treeBox for a while and hook up
   * the fake tree box to the db view. This also takes care of our
   * treeSelection object.
   *
   * @param aNullRealTreeBoxView true if we want to null out the real tree box.
   *          We don't want to null out the view if we're opening a background
   *          tab, for example.
   * @private
   */
  hookUpFakeTree(aNullRealTreeBoxView) {
    // save off the tree selection object.  the nsTreeBodyFrame will make the
    //  view forget about it when our view is removed, so it's up to us to
    //  save it.
    // We use this.treeSelection instead of this.view.dbView.selection here,
    //  so that we get the fake tree selection if we have it.
    let treeSelection = this.treeSelection;
    // if we want to, make the tree forget about the view right now so we can
    //  tell the db view about its selection object so it can try and keep it
    //  up-to-date even while hidden in the background
    if (aNullRealTreeBoxView && this.tree) {
      this.tree.view = null;
    }
    // (and tell the db view about its selection again...)
    this.view.dbView.selection = treeSelection;

    // hook the dbview up to the fake tree box
    this._fakeTree.view = this.view.dbView;
    this.view.dbView.setTree(this._fakeTree);
    treeSelection.tree = this._fakeTree;
  },

  /**
   * @name Command Support
   */
  // @{

  /**
   * @returns true if there is a db view and the command is enabled on the view.
   *  This function hides some of the XPCOM-odditities of the getCommandStatus
   *  call.
   */
  getCommandStatus(aCommandType, aEnabledObj, aCheckStatusObj) {
    // no view means not enabled
    if (!this.view.dbView) {
      return false;
    }
    let enabledObj = {},
      checkStatusObj = {};
    this.view.dbView.getCommandStatus(aCommandType, enabledObj, checkStatusObj);
    return enabledObj.value;
  },

  /**
   * Make code cleaner by allowing peoples to call doCommand on us rather than
   *  having to do folderDisplayWidget.view.dbView.doCommand.
   *
   * @param aCommandName The command name to invoke.
   */
  doCommand(aCommandName) {
    return this.view.dbView && this.view.dbView.doCommand(aCommandName);
  },

  /**
   * Make code cleaner by allowing peoples to call doCommandWithFolder on us
   *  rather than having to do:
   *  folderDisplayWidget.view.dbView.doCommandWithFolder.
   *
   * @param aCommandName The command name to invoke.
   * @param aFolder The folder context for the command.
   */
  doCommandWithFolder(aCommandName, aFolder) {
    return (
      this.view.dbView &&
      this.view.dbView.doCommandWithFolder(aCommandName, aFolder)
    );
  },
  // @}

  /**
   * @returns true when account central is being displayed.
   * @groupName Displayed
   */
  get isAccountCentralDisplayed() {
    return this.view.dbView == null;
  },

  /**
   * @name Navigation
   * @protected
   */
  // @{

  /**
   * Navigate using nsMsgNavigationType rules and ensuring the resulting row is
   *  visible.  This is trickier than it used to be because we now support
   *  treating collapsed threads as the set of all the messages in the collapsed
   *  thread rather than just the root message in that thread.
   *
   * @param {nsMsgNavigationType} aNavType navigation command.
   * @param {boolean} [aSelect=true] should we select the message if we find
   *     one?
   *
   * @returns true if the navigation constraint matched anything, false if not.
   *     We will have navigated if true, we will have done nothing if false.
   */
  navigate(aNavType, aSelect) {
    if (aSelect === undefined) {
      aSelect = true;
    }
    let resultKeyObj = {},
      resultIndexObj = {},
      threadIndexObj = {};

    let summarizeSelection = this.summarizeSelectionInFolder;

    let treeSelection = this.treeSelection; // potentially magic getter
    let currentIndex = treeSelection ? treeSelection.currentIndex : 0;

    let viewIndex;
    // if we're doing next unread, and a collapsed thread is selected, and
    // the top level message is unread, just set the result manually to
    // the top level message, without using viewNavigate.
    if (
      summarizeSelection &&
      aNavType == Ci.nsMsgNavigationType.nextUnreadMessage &&
      currentIndex != -1 &&
      this.view.isCollapsedThreadAtIndex(currentIndex) &&
      !(this.view.dbView.getFlagsAt(currentIndex) & Ci.nsMsgMessageFlags.Read)
    ) {
      viewIndex = currentIndex;
    } else {
      // always 'wrap' because the start index is relative to the selection.
      // (keep in mind that many forms of navigation do not care about the
      //  starting position or 'wrap' at all; for example, firstNew just finds
      //  the first new message.)
      // allegedly this does tree-expansion for us.
      this.view.dbView.viewNavigate(
        aNavType,
        resultKeyObj,
        resultIndexObj,
        threadIndexObj,
        true
      );
      viewIndex = resultIndexObj.value;
    }

    if (viewIndex == nsMsgViewIndex_None) {
      return false;
    }

    // - Expand if required.
    // (The nsMsgDBView isn't really aware of the varying semantics of
    //  collapsed threads, so viewNavigate might tell us about the root message
    //  and leave it collapsed, not realizing that it needs to be expanded.)
    if (summarizeSelection && this.view.isCollapsedThreadAtIndex(viewIndex)) {
      this.view.dbView.toggleOpenState(viewIndex);
    }

    if (aSelect) {
      this.selectViewIndex(viewIndex);
    } else {
      this.ensureRowIsVisible(viewIndex);
    }
    return true;
  },

  /**
   * Push a call to |navigate| to be what we do once we successfully open the
   *  next folder.  This is intended to be used by cross-folder navigation
   *  code.  It should call this method before triggering the folder change.
   */
  pushNavigation(aNavType, aSelect) {
    this._pendingNavigation = [aNavType, aSelect];
  },
  // @}

  /**
   * @name Selection
   */
  // @{

  /**
   * @returns the message header for the first selected message, or null if
   *  there is no selected message.
   *
   * If the user has right-clicked on a message, this method will return that
   *  message and not the 'current index' (the dude with the dotted selection
   *  rectangle around him.)  If you instead always want the currently
   *  displayed message (which is not impacted by right-clicking), then you
   *  would want to access the displayedMessage property on the
   *  MessageDisplayWidget.  You can get to that via the messageDisplay
   *  attribute on this object or (potentially) via the gMessageDisplay object.
   */
  get selectedMessage() {
    // there are inconsistencies in hdrForFirstSelectedMessage between
    //  nsMsgDBView and nsMsgSearchDBView in whether they use currentIndex,
    //  do it ourselves.  (nsMsgDBView does not use currentIndex, search does.)
    let treeSelection = this.treeSelection;
    if (!treeSelection || !treeSelection.count) {
      return null;
    }
    let minObj = {},
      maxObj = {};
    treeSelection.getRangeAt(0, minObj, maxObj);
    return this.view.dbView.getMsgHdrAt(minObj.value);
  },

  /**
   * @returns true if there is a selected message and it's an RSS feed message;
   *  a feed message does not have to be in an rss account folder if stored in
   *  Tb15 and later.
   */
  get selectedMessageIsFeed() {
    return FeedUtils.isFeedMessage(this.selectedMessage);
  },

  /**
   * @returns true if there is a selected message and it's an IMAP message.
   */
  get selectedMessageIsImap() {
    let message = this.selectedMessage;
    return Boolean(
      message &&
        message.folder &&
        message.folder.flags & Ci.nsMsgFolderFlags.ImapBox
    );
  },

  /**
   * @returns true if there is a selected message and it's a news message.  It
   *  would be great if messages knew this about themselves, but they don't.
   */
  get selectedMessageIsNews() {
    let message = this.selectedMessage;
    return Boolean(
      message &&
        message.folder &&
        message.folder.flags & Ci.nsMsgFolderFlags.Newsgroup
    );
  },

  /**
   * @returns true if there is a selected message and it's an external message,
   *  meaning it is loaded from an .eml file on disk or is an rfc822 attachment
   *  on a message.
   */
  get selectedMessageIsExternal() {
    let message = this.selectedMessage;
    // Dummy messages currently lack a folder.  This is not a great heuristic.
    // I have annotated msgHdrView.js which provides the dummy header to
    //  express this implementation dependency.
    // (Currently, since external mails can only be opened in standalone windows
    //  which subclass us, we could always return false, and have the subclass
    //  return true using its own heuristics.  But since we are moving to a tab
    //  model more heavily, at some point the 3-pane will need this.)
    return Boolean(message && !message.folder);
  },

  /**
   * @returns true if there is a selected message and the message belongs to an
   *              ignored thread.
   */
  get selectedMessageThreadIgnored() {
    let message = this.selectedMessage;
    return Boolean(
      message &&
        message.folder &&
        message.folder.msgDatabase.isIgnored(message.messageKey)
    );
  },

  /**
   * @returns true if there is a selected message and the message is the base
   *              message for an ignored subthread.
   */
  get selectedMessageSubthreadIgnored() {
    let message = this.selectedMessage;
    return Boolean(
      message && message.folder && message.flags & Ci.nsMsgMessageFlags.Ignored
    );
  },

  /**
   * @returns true if there is a selected message and the message belongs to a
   *              watched thread.
   */
  get selectedMessageThreadWatched() {
    let message = this.selectedMessage;
    return Boolean(
      message &&
        message.folder &&
        message.folder.msgDatabase.isWatched(message.messageKey)
    );
  },

  /**
   * @returns the number of selected messages.  If summarizeSelectionInFolder is
   *  true, then any collapsed thread roots that are selected will also
   *  conceptually have all of the messages in that thread selected.
   */
  get selectedCount() {
    return this.selectedMessages.length;
  },

  /**
   * Provides a list of the view indices that are selected which is *not* the
   *  same as the rows of the selected messages.  When
   *  summarizeSelectionInFolder is true, messages may be selected but not
   *  visible (because the thread root is selected.)
   * You probably want to use the |selectedMessages| attribute instead of this
   *  one.  (Or selectedMessageUris in some rare cases.)
   *
   * If the user has right-clicked on a message, this will return that message
   *  and not the selection prior to the right-click.
   *
   * @returns a list of the view indices that are currently selected
   */
  get selectedIndices() {
    if (!this.view.dbView) {
      return [];
    }

    return this.view.dbView.getIndicesForSelection();
  },

  /**
   * Provides a list of the message headers for the currently selected messages.
   *  If summarizeSelectionInFolder is true, then any collapsed thread roots
   *  that are selected will also (conceptually) have all of the messages in
   *  that thread selected and they will be included in the returned list.
   *
   * If the user has right-clicked on a message, this will return that message
   *  (and any collapsed children if so enabled) and not the selection prior to
   *  the right-click.
   *
   * @returns a list of the message headers for the currently selected messages.
   *     If there are no selected messages, the result is an empty list.
   */
  get selectedMessages() {
    if (!this._active && this._savedSelection?.messages) {
      return this._savedSelection.messages
        .map(savedInfo => this.view.getMsgHdrForMessageID(savedInfo.messageId))
        .filter(msgHdr => !!msgHdr);
    }
    if (!this.view.dbView) {
      return [];
    }
    return this.view.dbView.getSelectedMsgHdrs();
  },

  /**
   * @returns a list of the URIs for the currently selected messages or null
   *     (instead of a list) if there are no selected messages.  Do not
   *     pass around URIs unless you have a good reason.  Legacy code is an
   *     ok reason.
   *
   * If the user has right-clicked on a message, this will return that message's
   *  URI and not the selection prior to the right-click.
   */
  get selectedMessageUris() {
    if (!this.view.dbView) {
      return null;
    }

    let messageArray = this.view.dbView.getURIsForSelection();
    return messageArray.length ? messageArray : null;
  },

  /**
   * @returns true if all the selected messages can be archived, false otherwise.
   */
  get canArchiveSelectedMessages() {
    return false;
  },

  /**
   * The maximum number of messages canMarkThreadAsRead will look through.
   * If the number exceeds this limit, as a performance measure, we return
   * true rather than looking through the messages and possible
   * submessages.
   */
  MAX_COUNT_FOR_MARK_THREAD: 1000,

  /**
   * Check if the thread for the currently selected message can be marked as
   * read. A thread can be marked as read if and only if it has at least one
   * unread message.
   */
  get canMarkThreadAsRead() {
    if (
      (this.displayedFolder && this.displayedFolder.getNumUnread(false) > 0) ||
      this.view._underlyingData === this.view.kUnderlyingSynthetic
    ) {
      // If the messages limit is exceeded we bail out early and return true.
      if (this.selectedIndices.length > this.MAX_COUNT_FOR_MARK_THREAD) {
        return true;
      }

      for (let i of this.selectedIndices) {
        if (
          this.view.dbView.getThreadContainingIndex(i).numUnreadChildren > 0
        ) {
          return true;
        }
      }
    }
    return false;
  },

  /**
   * @returns true if all the selected messages can be deleted from their
   * folders, false otherwise.
   */
  get canDeleteSelectedMessages() {
    if (!this.view.dbView) {
      return false;
    }

    let selectedMessages = this.selectedMessages;
    for (let i = 0; i < selectedMessages.length; ++i) {
      if (
        selectedMessages[i].folder &&
        (!selectedMessages[i].folder.canDeleteMessages ||
          selectedMessages[i].folder.flags & Ci.nsMsgFolderFlags.Newsgroup)
      ) {
        return false;
      }
    }
    return true;
  },

  /**
   * Clear the tree selection, making sure the message pane is cleared and
   *  the context display (toolbars, etc.) are updated.
   */
  clearSelection() {
    let treeSelection = this.treeSelection; // potentially magic getter
    if (!treeSelection) {
      return;
    }
    treeSelection.clearSelection();
    this._updateContextDisplay();
  },

  // Whether we're about to select a message
  _aboutToSelectMessage: false,

  /**
   * This needs to be called to let us know that a selectMessage or equivalent
   * is coming  up right after a show() call, so that we know that a double
   * message load won't be happening.
   *
   * This can be assumed to be idempotent.
   */
  selectMessageComingUp() {
    this._aboutToSelectMessage = true;
  },

  /**
   * Select a message for display by header.  Attempt to select the message
   *  right now.  If we were unable to find it, update our saved selection
   *  to want to display the message.  Threads are expanded to find the header.
   *
   * @param aMsgHdr The message header to select for display.
   * @param [aForceSelect] If the message is not in the view and this is true,
   *                       we will drop any applied view filters to look for the
   *                       message. The dropping of view filters is persistent,
   *                       so use with care. Defaults to false.
   */
  selectMessage(aMsgHdr, aForceSelect) {
    let viewIndex = this.view.getViewIndexForMsgHdr(aMsgHdr, aForceSelect);
    if (viewIndex != nsMsgViewIndex_None) {
      this._savedSelection = null;
      this.selectViewIndex(viewIndex);
    } else {
      this._savedSelection = {
        messages: [{ messageId: aMsgHdr.messageId }],
        forceSelect: aForceSelect,
      };
      // queue the selection to be restored once we become active if we are not
      //  active.
      if (!this.active) {
        this._notifyWhenActive(this._restoreSelection);
      }
    }

    // Do this here instead of at the beginning to prevent reentrancy issues
    this._aboutToSelectMessage = false;
  },

  /**
   * Select all of the provided nsIMsgDBHdrs in the aMessages array, expanding
   *  threads as required.  If we were not able to find all of the messages,
   *  update our saved selection to want to display the messages.  The messages
   *  will then be selected when we are made active or all messages in the
   *  folder complete loading.  This is to accommodate the use-case where we
   *  are backed by an in-progress search and no
   *
   * @param aMessages An array of nsIMsgDBHdr instances.
   * @param [aForceSelect] If a message is not in the view and this is true,
   *                       we will drop any applied view filters to look for the
   *                       message. The dropping of view filters is persistent,
   *                       so use with care. Defaults to false.
   * @param aDoNotNeedToFindAll If true (can be omitted and left undefined), we
   *     do not attempt to save the selection for future use.  This is intended
   *     for use by the _restoreSelection call which is the end-of-the-line for
   *     restoring the selection.  (Once it gets called all of our messages
   *     should have already been loaded.)
   */
  selectMessages(aMessages, aForceSelect, aDoNotNeedToFindAll) {
    let treeSelection = this.treeSelection; // potentially magic getter
    let foundAll = true;
    if (treeSelection) {
      let minRow = null,
        maxRow = null;

      treeSelection.selectEventsSuppressed = true;
      treeSelection.clearSelection();

      for (let msgHdr of aMessages) {
        let viewIndex = this.view.getViewIndexForMsgHdr(msgHdr, aForceSelect);

        if (viewIndex != nsMsgViewIndex_None) {
          if (minRow == null || viewIndex < minRow) {
            minRow = viewIndex;
          }
          if (maxRow == null || viewIndex > maxRow) {
            maxRow = viewIndex;
          }
          // nsTreeSelection is actually very clever about doing this
          //  efficiently.
          treeSelection.rangedSelect(viewIndex, viewIndex, true);
        } else {
          foundAll = false;
        }

        // make sure the selection is as visible as possible
        if (minRow != null) {
          this.ensureRowRangeIsVisible(minRow, maxRow);
        }
      }

      treeSelection.selectEventsSuppressed = false;

      // If we haven't selected every message, we'll set |this._savedSelection|
      // below, so it's fine to null it out at this point.
      this._savedSelection = null;
    }

    // Do this here instead of at the beginning to prevent reentrancy issues
    this._aboutToSelectMessage = false;

    // Two cases.
    // 1. The tree selection isn't there at all.
    // 2. The tree selection is there, and we needed to find all messages, but
    //    we didn't.
    if (!treeSelection || (!aDoNotNeedToFindAll && !foundAll)) {
      this._savedSelection = {
        messages: aMessages.map(msgHdr => ({ messageId: msgHdr.messageId })),
        forceSelect: aForceSelect,
      };
      if (!this.active) {
        this._notifyWhenActive(this._restoreSelection);
      }
    }
  },

  /**
   * Select the message at view index.
   *
   * @param aViewIndex The view index to select.  This will be bounds-checked
   *     and if it is outside the bounds, we will clear the selection and
   *     bail.
   */
  selectViewIndex(aViewIndex) {
    let treeSelection = this.treeSelection;
    // if we have no selection, we can't select something
    if (!treeSelection) {
      return;
    }
    let rowCount = this.view.dbView.rowCount;
    if (
      aViewIndex == nsMsgViewIndex_None ||
      aViewIndex < 0 ||
      aViewIndex >= rowCount
    ) {
      this.clearSelection();
      return;
    }

    // Check whether the index is already selected/current.  This can be the
    //  case when we are here as the result of a deletion.  Assuming
    //  nsMsgDBView::NoteChange ran and was not suppressing change
    //  notifications, then it's very possible the selection is already where
    //  we want it to go.  However, in that case, nsMsgDBView::SelectionChanged
    //  bailed without doing anything because m_deletingRows...
    // So we want to generate a change notification if that is the case. (And
    //  we still want to call ensureRowIsVisible, as there may be padding
    //  required.)
    if (
      treeSelection.count == 1 &&
      (treeSelection.currentIndex == aViewIndex ||
        treeSelection.isSelected(aViewIndex))
    ) {
      // Make sure the index we just selected is also the current index.
      //  This can happen when the tree selection adjusts itself as a result of
      //  changes to the tree as a result of deletion.  This will not trigger
      //  a notification.
      treeSelection.select(aViewIndex);
      this.view.dbView.selectionChanged();
    } else {
      // Previous code was concerned about avoiding updating commands on the
      //  assumption that only the selection count mattered.  We no longer
      //  make this assumption.
      // Things that may surprise you about the call to treeSelection.select:
      // 1) This ends up calling the onselect method defined on the XUL 'tree'
      //    tag.  For the 3pane this is the ThreadPaneSelectionChanged method in
      //    threadPane.js.  That code checks a global to see if it is dealing
      //    with a right-click, and ignores it if so.
      treeSelection.select(aViewIndex);
    }

    if (this._active) {
      this.ensureRowIsVisible(aViewIndex);
    }

    // The saved selection is invalidated, since we've got something newer
    this._savedSelection = null;

    // Do this here instead of at the beginning to prevent reentrancy issues
    this._aboutToSelectMessage = false;
  },

  /**
   * For every selected message in the display that is part of a (displayed)
   *  thread and is not the root message, de-select it and ensure that the
   *  root message of the thread is selected.
   * This is primarily intended to be used when collapsing visible threads.
   *
   * We do nothing if we are not in a threaded display mode.
   */
  selectSelectedThreadRoots() {
    if (!this.view.showThreaded) {
      return;
    }

    // There are basically two implementation strategies available to us:
    // 1) For each selected view index with a level > 0, keep walking 'up'
    //    (numerically smaller) until we find a message with level 0.
    //    The inefficiency here is the potentially large number of JS calls
    //    into XPCOM space that will be required.
    // 2) Ask for the thread that each view index belongs to, use that to
    //    efficiently retrieve the thread root, then find the root using
    //    the message header.  The inefficiency here is that the view
    //    currently does a linear scan, albeit a relatively efficient one.
    // And the winner is... option 2, because the code is simpler because we
    //  can reuse selectMessages to do most of the work.
    let selectedIndices = this.selectedIndices;
    let newSelectedMessages = [];
    let dbView = this.view.dbView;
    for (let index of selectedIndices) {
      let thread = dbView.getThreadContainingIndex(index);
      newSelectedMessages.push(thread.getRootHdr());
    }
    this.selectMessages(newSelectedMessages);
  },

  // @}

  /**
   * @name Ensure Visibility
   */
  // @{

  /**
   * Minimum number of lines to display between the 'focused' message and the
   *  top / bottom of the thread pane.
   */
  get visibleRowPadding() {
    let topPadding, bottomPadding;

    // If we can get the height of the folder pane, treat the values as
    //  percentages of that.
    if (this.tree) {
      let topPercentPadding = Services.prefs.getIntPref(
        "mail.threadpane.padding.top_percent"
      );
      let bottomPercentPadding = Services.prefs.getIntPref(
        "mail.threadpane.padding.bottom_percent"
      );

      // Assume the bottom row is half-visible and should generally be ignored.
      // (We could actually do the legwork to see if there is a partial one...)
      let paneHeight = this.tree.getPageLength() - 1;

      // Convert from percentages to absolute row counts.
      topPadding = Math.ceil((topPercentPadding / 100) * paneHeight);
      bottomPadding = Math.ceil((bottomPercentPadding / 100) * paneHeight);

      // We need one visible row not counted in either padding, for the actual
      //  target message. Also helps correct for rounding errors.
      if (topPadding + bottomPadding > paneHeight) {
        if (topPadding > bottomPadding) {
          topPadding--;
        } else {
          bottomPadding--;
        }
      }
    } else {
      // Something's gone wrong elsewhere, and we likely have bigger problems.
      topPadding = 0;
      bottomPadding = 0;
      console.error("Unable to get height of folder pane (treeBox is null)");
    }

    return [topPadding, bottomPadding];
  },

  /**
   * Ensure the given view index is visible, optionally with some padding.
   * By padding, we mean that the index will not be the first or last message
   *  displayed, but rather have messages on either side.
   * We have the concept of a 'lip' when we are at the end of the message
   *  display.  If we are near the end of the display, we want to show an
   *  empty row (at the bottom) so the user knows they are at the end.  Also,
   *  if a message shows up that is new and things are sorted ascending, this
   *  turns out to be useful.
   */
  ensureRowIsVisible(aViewIndex, aBounced) {
    // Dealing with the tree view layout is a nightmare, let's just always make
    //  sure we re-schedule ourselves.  The most particular rationale here is
    //  that the message pane may be toggling its state and it's much simpler
    //  and reliable if we ensure that all of FolderDisplayWidget's state
    //  change logic gets to run to completion before we run ourselves.
    if (!aBounced) {
      let dis = this;
      window.setTimeout(function () {
        dis.ensureRowIsVisible(aViewIndex, true);
      }, 0);
    }

    let tree = this.tree;
    if (!tree || !tree.view) {
      return;
    }

    // try and trigger a reflow...
    tree.getBoundingClientRect();

    let maxIndex = tree.view.rowCount - 1;

    let first = tree.getFirstVisibleRow();
    // Assume the bottom row is half-visible and should generally be ignored.
    // (We could actually do the legwork to see if there is a partial one...)
    const halfVisible = 1;
    let last = tree.getLastVisibleRow() - halfVisible;
    let span = tree.getPageLength() - halfVisible;
    let [topPadding, bottomPadding] = this.visibleRowPadding;

    let target;
    if (aViewIndex >= last - bottomPadding) {
      // The index is after the last visible guy (with padding),
      // move down so that the target index is padded in 1 from the bottom.
      target = Math.min(maxIndex, aViewIndex + bottomPadding) - span;
    } else if (aViewIndex <= first + topPadding) {
      // The index is before the first visible guy (with padding), move up.
      target = Math.max(0, aViewIndex - topPadding);
    } else {
      // It is already visible.
      return;
    }

    // this sets the first visible row
    tree.scrollToRow(target);
  },

  /**
   * Ensure that the given range of rows is maximally visible in the thread
   *  pane.  If the range is larger than the number of rows that can be
   *  displayed in the thread pane, we bias towards showing the min row (with
   *  padding).
   *
   * @param aMinRow The numerically smallest row index defining the start of
   *     the inclusive range.
   * @param aMaxRow The numberically largest row index defining the end of the
   *     inclusive range.
   */
  ensureRowRangeIsVisible(aMinRow, aMaxRow, aBounced) {
    // Dealing with the tree view layout is a nightmare, let's just always make
    //  sure we re-schedule ourselves.  The most particular rationale here is
    //  that the message pane may be toggling its state and it's much simpler
    //  and reliable if we ensure that all of FolderDisplayWidget's state
    //  change logic gets to run to completion before we run ourselves.
    if (!aBounced) {
      let dis = this;
      window.setTimeout(function () {
        dis.ensureRowRangeIsVisible(aMinRow, aMaxRow, true);
      }, 0);
    }

    let tree = this.tree;
    if (!tree) {
      return;
    }
    let first = tree.getFirstVisibleRow();
    const halfVisible = 1;
    let last = tree.getLastVisibleRow() - halfVisible;
    let span = tree.getPageLength() - halfVisible;
    let [topPadding, bottomPadding] = this.visibleRowPadding;

    // bail if the range is already visible with padding constraints handled
    if (first + topPadding <= aMinRow && last - bottomPadding >= aMaxRow) {
      return;
    }

    let target;
    // if the range is bigger than we can fit, optimize position for the min row
    //  with padding to make it obvious the range doesn't extend above the row.
    if (aMaxRow - aMinRow > span) {
      target = Math.max(0, aMinRow - topPadding);
    } else {
      // So the range must fit, and it's a question of how we want to position
      //  it.  For now, the answer is we try and center it, why not.
      let rowSpan = aMaxRow - aMinRow + 1;
      let halfSpare = Math.floor(
        (span - rowSpan - topPadding - bottomPadding) / 2
      );
      target = aMinRow - halfSpare - topPadding;
    }
    tree.scrollToRow(target);
  },

  /**
   * Ensure that the selection is visible to the extent possible.
   */
  ensureSelectionIsVisible() {
    let treeSelection = this.treeSelection; // potentially magic getter
    if (!treeSelection || !treeSelection.count) {
      return;
    }

    let minRow = null,
      maxRow = null;

    let rangeCount = treeSelection.getRangeCount();
    for (let iRange = 0; iRange < rangeCount; iRange++) {
      let rangeMinObj = {},
        rangeMaxObj = {};
      treeSelection.getRangeAt(iRange, rangeMinObj, rangeMaxObj);
      let rangeMin = rangeMinObj.value,
        rangeMax = rangeMaxObj.value;
      if (minRow == null || rangeMin < minRow) {
        minRow = rangeMin;
      }
      if (maxRow == null || rangeMax > maxRow) {
        maxRow = rangeMax;
      }
    }

    this.ensureRowRangeIsVisible(minRow, maxRow);
  },
  // @}
};

function SetNewsFolderColumns() {
  var sizeColumn = document.getElementById("sizeCol");
  var bundle = document.getElementById("bundle_messenger");

  if (gDBView.usingLines) {
    sizeColumn.setAttribute("label", bundle.getString("linesColumnHeader"));
    sizeColumn.setAttribute(
      "tooltiptext",
      bundle.getString("linesColumnTooltip2")
    );
  } else {
    sizeColumn.setAttribute("label", bundle.getString("sizeColumnHeader"));
    sizeColumn.setAttribute(
      "tooltiptext",
      bundle.getString("sizeColumnTooltip2")
    );
  }
}

function UpdateStatusQuota(folder) {
  if (!document.getElementById("quotaPanel")) {
    // No quotaPanel in here, like for the search window.
    return;
  }

  if (!(folder && folder instanceof Ci.nsIMsgImapMailFolder)) {
    document.getElementById("quotaPanel").hidden = true;
    return;
  }

  let quotaUsagePercentage = q =>
    Number((100n * BigInt(q.usage)) / BigInt(q.limit));

  // For display on main window panel only include quota names containing
  // "STORAGE" or "MESSAGE". This will exclude unusual quota names containing
  // items like "MAILBOX" and "LEVEL" from the panel bargraph. All quota names
  // will still appear on the folder properties quota window.
  // Note: Quota name is typically something like "User Quota / STORAGE".
  let folderQuota = folder
    .getQuota()
    .filter(
      quota =>
        quota.name.toUpperCase().includes("STORAGE") ||
        quota.name.toUpperCase().includes("MESSAGE")
    );
  // If folderQuota not empty, find the index of the element with highest
  //  percent usage and determine if it is above the panel display threshold.
  if (folderQuota.length > 0) {
    let highest = folderQuota.reduce((acc, current) =>
      quotaUsagePercentage(acc) > quotaUsagePercentage(current) ? acc : current
    );
    let percent = quotaUsagePercentage(highest);
    if (
      percent <
      Services.prefs.getIntPref("mail.quota.mainwindow_threshold.show")
    ) {
      document.getElementById("quotaPanel").hidden = true;
    } else {
      document.getElementById("quotaPanel").hidden = false;
      document.getElementById("quotaMeter").setAttribute("value", percent);
      var bundle = document.getElementById("bundle_messenger");
      document.getElementById("quotaLabel").value = bundle.getFormattedString(
        "percent",
        [percent]
      );
      document.getElementById("quotaLabel").tooltipText =
        bundle.getFormattedString("quotaTooltip2", [
          highest.usage,
          highest.limit,
        ]);
      let quotaPanel = document.getElementById("quotaPanel");
      if (
        percent <
        Services.prefs.getIntPref("mail.quota.mainwindow_threshold.warning")
      ) {
        quotaPanel.classList.remove("alert-warning", "alert-critical");
      } else if (
        percent <
        Services.prefs.getIntPref("mail.quota.mainwindow_threshold.critical")
      ) {
        quotaPanel.classList.remove("alert-critical");
        quotaPanel.classList.add("alert-warning");
      } else {
        quotaPanel.classList.remove("alert-warning");
        quotaPanel.classList.add("alert-critical");
      }
    }
  } else {
    document.getElementById("quotaPanel").hidden = true;
  }
}
