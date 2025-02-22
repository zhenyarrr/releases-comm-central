/*
 * This file tests that a pop3 move filter doesn't reuse msg hdr
 * info from previous moves.
 *
 * Original author: David Bienvenu <dbienvenu@mozilla.com>
 */

/* import-globals-from ../../../test/resources/POP3pump.js */
load("../../../resources/POP3pump.js");
var gFiles = ["../../../data/bugmail10", "../../../data/basic1"];

Services.prefs.setBoolPref("mail.server.default.leave_on_server", true);

// Currently we have two mailbox storage formats.
var gPluggableStores = [
  "@mozilla.org/msgstore/berkeleystore;1",
  "@mozilla.org/msgstore/maildirstore;1",
];
var basic1_preview = "Hello, world!";
var bugmail10_preview =
  "Do not reply to this email. You can add comments to this bug at https://bugzilla.mozilla.org/show_bug.cgi?id=436880 -- Configure bugmail: https://bugzilla.mozilla.org/userprefs.cgi?tab=email ------- You are receiving this mail because: -----";

var gMoveFolder;
var gFilter; // the test filter
var gFilterList;
var gTestArray = [
  function createFilters() {
    gFilterList = gPOP3Pump.fakeServer.getFilterList(null);
    // create a cc filter which will match the first message but not the second.
    gFilter = gFilterList.createFilter("MoveCc");
    let searchTerm = gFilter.createTerm();
    searchTerm.attrib = Ci.nsMsgSearchAttrib.CC;
    searchTerm.op = Ci.nsMsgSearchOp.Contains;
    var oldValue = searchTerm.value;
    oldValue.attrib = Ci.nsMsgSearchAttrib.CC;
    oldValue.str = "invalid@example.com";
    searchTerm.value = oldValue;
    gFilter.appendTerm(searchTerm);
    let moveAction = gFilter.createAction();
    moveAction.type = Ci.nsMsgFilterAction.MoveToFolder;
    moveAction.targetFolderUri = gMoveFolder.URI;
    gFilter.appendAction(moveAction);
    gFilter.enabled = true;
    gFilter.filterType = Ci.nsMsgFilterType.InboxRule;
    gFilterList.insertFilterAt(0, gFilter);
  },
  // just get a message into the local folder
  async function getLocalMessages1() {
    gPOP3Pump.files = gFiles;
    await gPOP3Pump.run();
  },
  function verifyFolders2() {
    Assert.equal(folderCount(gMoveFolder), 1);
    // the local inbox folder should have one message.
    Assert.equal(folderCount(localAccountUtils.inboxFolder), 1);
  },
  function verifyMessages() {
    // check MoveFolder message
    let hdr = [...gMoveFolder.msgDatabase.enumerateMessages()][0];
    Assert.ok(!gMoveFolder.fetchMsgPreviewText([hdr.messageKey], null));
    Assert.equal(hdr.getStringProperty("preview"), bugmail10_preview);
    // check inbox message
    hdr = [...localAccountUtils.inboxFolder.msgDatabase.enumerateMessages()][0];
    Assert.ok(
      !localAccountUtils.inboxFolder.fetchMsgPreviewText([hdr.messageKey], null)
    );
    Assert.equal(hdr.getStringProperty("preview"), basic1_preview);
  },
];

function folderCount(folder) {
  return [...folder.msgDatabase.enumerateMessages()].length;
}

function setup_store(storeID) {
  return function _setup_store() {
    // Initialize pop3Pump with correct mailbox format.
    gPOP3Pump.resetPluggableStore(storeID);

    // Set the default mailbox store.
    Services.prefs.setCharPref("mail.serverDefaultStoreContractID", storeID);

    // Make sure we're not quarantining messages
    Services.prefs.setBoolPref("mailnews.downloadToTempFile", false);
    if (!localAccountUtils.inboxFolder) {
      localAccountUtils.loadLocalMailAccount();
    }

    gMoveFolder =
      localAccountUtils.rootFolder.createLocalSubfolder("MoveFolder");
  };
}

function run_test() {
  for (let store of gPluggableStores) {
    add_task(setup_store(store));
    gTestArray.forEach(x => add_task(x));
  }

  add_task(exitTest);
  run_next_test();
}

function exitTest() {
  // Cleanup and exit the test.
  info("Exiting mail tests\n");
  gPOP3Pump = null;
}
