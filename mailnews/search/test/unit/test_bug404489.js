/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tests that custom headers like "Sender" work (bug 404489)

var { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm"
);

var Contains = Ci.nsMsgSearchOp.Contains;
var gArrayHdrs = ["X-Bugzilla-Who", "Sender"];
var gFirstHeader = Ci.nsMsgSearchAttrib.OtherHeader + 1;
var fileName = "../../../data/SenderHeader";

var Tests = [
  /* test header:
  X-Bugzilla-Who: bugmail@example.org

  This just shows that normal custom headers work
  */
  {
    testValue: "bugmail",
    attrib: gFirstHeader,
    op: Contains,
    count: 1,
  },
  {
    testValue: "ThisIsNotThere",
    attrib: gFirstHeader,
    op: Contains,
    count: 0,
  },
  /* test header:
  Sender: iamthesender@example.com

  This is the main fix of bug 404489, that we can use Sender as a header
  */
  {
    testValue: "iamthesender",
    attrib: gFirstHeader + 1,
    op: Contains,
    count: 1,
  },
  /* test header:
  From: bugzilla-daemon@mozilla.invalid

  Here we show that the "From" header does not fire tests for the
  "Sender" arbitrary headers, but does fire the standard test
  for nsMsgSenderAttrib.Sender
  */
  {
    testValue: "bugzilla",
    attrib: gFirstHeader + 1,
    op: Contains,
    count: 0,
  },
  {
    testValue: "bugzilla",
    attrib: Ci.nsMsgSearchAttrib.Sender,
    op: Contains,
    count: 1,
  },
];

function run_test() {
  localAccountUtils.loadLocalMailAccount();

  // add the custom headers into the preferences file, ":" delimited

  var hdrs;
  if (gArrayHdrs.length == 1) {
    hdrs = gArrayHdrs;
  } else {
    hdrs = gArrayHdrs.join(": ");
  }
  Services.prefs.setCharPref("mailnews.customHeaders", hdrs);

  // Get a message into the local filestore. function continue_test() continues the testing after the copy.
  do_test_pending();
  var file = do_get_file(fileName);
  MailServices.copy.copyFileMessage(
    file,
    localAccountUtils.inboxFolder,
    null,
    false,
    0,
    "",
    copyListener,
    null
  );
  return true;
}

var copyListener = {
  OnStartCopy() {},
  OnProgress(aProgress, aProgressMax) {},
  SetMessageKey(aKey) {},
  SetMessageId(aMessageId) {},
  OnStopCopy(aStatus) {
    continue_test();
  },
};

// Runs at completion of each copy
// process each test from queue, calls itself upon completion of each search
function continue_test() {
  var test = Tests.shift();
  if (test) {
    new TestSearchx(
      localAccountUtils.inboxFolder,
      test.testValue,
      test.attrib,
      test.op,
      test.count,
      continue_test
    );
  } else {
    do_test_finished();
  }
}

/*
 * TestSearchx: Class to test number of search hits
 *
 * @param aFolder:   the folder to search
 * @param aValue:    value used for the search
 *                   The interpretation of aValue depends on aAttrib. It
 *                   defaults to string, but for certain attributes other
 *                   types are used.
 *                   WARNING: not all attributes have been tested.
 *
 * @param aAttrib:   attribute for the search (Ci.nsMsgSearchAttrib.Size, etc.)
 * @param aOp:       operation for the search (Ci.nsMsgSearchOp.Contains, etc.)
 * @param aHitCount: expected number of search hits
 * @param onDone:    function to call on completion of search
 *
 */

function TestSearchx(aFolder, aValue, aAttrib, aOp, aHitCount, onDone) {
  var searchListener = {
    onSearchHit(dbHdr, folder) {
      hitCount++;
    },
    onSearchDone(status) {
      print("Finished search does " + aHitCount + " equal " + hitCount + "?");
      searchSession = null;
      Assert.equal(aHitCount, hitCount);
      if (onDone) {
        onDone();
      }
    },
    onNewSearch() {
      hitCount = 0;
    },
  };

  // define and initiate the search session

  var hitCount;
  var searchSession = Cc[
    "@mozilla.org/messenger/searchSession;1"
  ].createInstance(Ci.nsIMsgSearchSession);
  searchSession.addScopeTerm(Ci.nsMsgSearchScope.offlineMail, aFolder);
  var searchTerm = searchSession.createTerm();
  searchTerm.attrib = aAttrib;

  var value = searchTerm.value;
  // This is tricky - value.attrib must be set before actual values
  value.attrib = aAttrib;
  if (aAttrib == Ci.nsMsgSearchAttrib.JunkPercent) {
    value.junkPercent = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.Priority) {
    value.priority = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.Date) {
    value.date = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.MsgStatus) {
    value.status = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.MessageKey) {
    value.msgKey = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.Size) {
    value.size = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.AgeInDays) {
    value.age = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.JunkStatus) {
    value.junkStatus = aValue;
  } else if (aAttrib == Ci.nsMsgSearchAttrib.HasAttachmentStatus) {
    value.status = Ci.nsMsgMessageFlags.Attachment;
  } else {
    value.str = aValue;
  }
  searchTerm.value = value;
  if (aAttrib > Ci.nsMsgSearchAttrib.OtherHeader) {
    searchTerm.arbitraryHeader =
      gArrayHdrs[aAttrib - 1 - Ci.nsMsgSearchAttrib.OtherHeader];
  }
  searchTerm.op = aOp;
  searchTerm.booleanAnd = false;
  searchSession.appendTerm(searchTerm);
  searchSession.registerListener(searchListener);
  searchSession.search(null);
}
