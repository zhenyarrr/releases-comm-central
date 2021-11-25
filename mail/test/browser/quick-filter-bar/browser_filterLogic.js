/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Verify that we are constructing the filters that we expect and that they
 * are hooked up to the right buttons.
 */

"use strict";

var {
  assert_messages_in_view,
  assert_messages_not_in_view,
  be_in_folder,
  create_folder,
  mc,
  MessageInjection,
} = ChromeUtils.import(
  "resource://testing-common/mozmill/FolderDisplayHelpers.jsm"
);
var {
  assert_quick_filter_bar_visible,
  assert_results_label_count,
  assert_text_constraints_checked,
  clear_constraints,
  set_filter_text,
  toggle_boolean_constraints,
  toggle_quick_filter_bar,
  toggle_tag_constraints,
  toggle_tag_mode,
  toggle_text_constraints,
} = ChromeUtils.import(
  "resource://testing-common/mozmill/QuickFilterBarHelpers.jsm"
);

var { MailServices } = ChromeUtils.import(
  "resource:///modules/MailServices.jsm"
);

add_task(function test_filter_unread() {
  let folder = create_folder("QuickFilterBarFilterUnread");
  let [unread, read] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1 },
  ]);
  read.setRead(true);

  be_in_folder(folder);
  toggle_boolean_constraints("unread");
  assert_messages_in_view(unread);
  teardownTest();
});

add_task(function test_filter_starred() {
  let folder = create_folder("QuickFilterBarFilterStarred");
  let [, starred] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1 },
  ]);
  starred.setStarred(true);

  be_in_folder(folder);
  toggle_boolean_constraints("starred");
  assert_messages_in_view(starred);
  teardownTest();
});

add_task(function test_filter_simple_intersection_unread_and_starred() {
  let folder = create_folder("QuickFilterBarFilterUnreadAndStarred");
  let [
    ,
    readUnstarred,
    unreadStarred,
    readStarred,
  ] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1 },
    { count: 1 },
    { count: 1 },
  ]);
  readUnstarred.setRead(true);
  unreadStarred.setStarred(true);
  readStarred.setRead(true);
  readStarred.setStarred(true);

  be_in_folder(folder);
  toggle_boolean_constraints("unread", "starred");

  assert_messages_in_view(unreadStarred);
  teardownTest();
});

add_task(function test_filter_attachments() {
  let attachSetDef = {
    count: 1,
    attachments: [
      {
        filename: "foo.png",
        contentType: "image/png",
        encoding: "base64",
        charset: null,
        body: "YWJj\n",
        format: null,
      },
    ],
  };
  let noAttachSetDef = {
    count: 1,
  };

  let folder = create_folder("QuickFilterBarFilterAttachments");
  let [, setAttach] = MessageInjection.make_new_sets_in_folder(folder, [
    noAttachSetDef,
    attachSetDef,
  ]);

  be_in_folder(folder);
  toggle_boolean_constraints("attachments");

  assert_messages_in_view(setAttach);
  teardownTest();
});

/**
 * Create a card for the given e-mail address, adding it to the first address
 * book we can find.
 */
function add_email_to_address_book(aEmailAddr) {
  let card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  card.primaryEmail = aEmailAddr;

  for (let addrbook of MailServices.ab.directories) {
    addrbook.addCard(card);
    return;
  }

  throw new Error("Unable to find any suitable address book.");
}

add_task(function test_filter_in_address_book() {
  let bookSetDef = {
    from: ["Qbert Q Qbington", "q@q.invalid"],
    count: 1,
  };
  add_email_to_address_book(bookSetDef.from[1]);
  let folder = create_folder("MesssageFilterBarInAddressBook");
  let [setBook] = MessageInjection.make_new_sets_in_folder(folder, [
    bookSetDef,
    { count: 1 },
  ]);
  be_in_folder(folder);
  toggle_boolean_constraints("addrbook");
  assert_messages_in_view(setBook);
  teardownTest();
});

add_task(function test_filter_tags() {
  let folder = create_folder("QuickFilterBarTags");
  const tagA = "$label1",
    tagB = "$label2",
    tagC = "$label3";
  let [
    setNoTag,
    setTagA,
    setTagB,
    setTagAB,
    setTagC,
  ] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1 },
    { count: 1 },
    { count: 1 },
    { count: 1 },
  ]);
  setTagA.addTag(tagA);
  setTagB.addTag(tagB);
  setTagAB.addTag(tagA);
  setTagAB.addTag(tagB);
  setTagC.addTag(tagC);

  be_in_folder(folder);
  toggle_boolean_constraints("tags"); // must have a tag
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);

  toggle_tag_constraints(tagA); // must have tag A
  assert_messages_in_view([setTagA, setTagAB]);

  toggle_tag_constraints(tagB);
  // mode is OR by default -> must have tag A or tag B
  assert_messages_in_view([setTagA, setTagB, setTagAB]);

  toggle_tag_mode();
  // mode is now AND -> must have tag A and tag B
  assert_messages_in_view([setTagAB]);

  toggle_tag_constraints(tagA); // must have tag B
  assert_messages_in_view([setTagB, setTagAB]);

  toggle_tag_constraints(tagB); // have have a tag
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);

  toggle_boolean_constraints("tags"); // no constraints
  assert_messages_in_view([setNoTag, setTagA, setTagB, setTagAB, setTagC]);

  // If we have filtered to a specific tag and we disable the tag filter
  // entirely, make sure that when we turn it back on we are just back to "any
  // tag".
  toggle_boolean_constraints("tags");
  toggle_tag_constraints(tagC);
  assert_messages_in_view(setTagC);

  toggle_boolean_constraints("tags"); // no constraints
  toggle_boolean_constraints("tags"); // should be any tag (not tagC!)
  assert_messages_in_view([setTagA, setTagB, setTagAB, setTagC]);
  teardownTest();
});

add_task(function test_filter_text_single_word_and_predicates() {
  let folder = create_folder("QuickFilterBarTextSingleWord");
  let whoFoo = ["zabba", "foo@madeup.invalid"];
  let [
    ,
    setSenderFoo,
    setRecipientsFoo,
    setSubjectFoo,
    setBodyFoo,
  ] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1, from: whoFoo },
    { count: 1, to: [whoFoo] },
    { count: 1, subject: "foo" },
    { count: 1, body: { body: "foo" } },
  ]);
  be_in_folder(folder);

  // by default, sender/recipients/subject are selected
  assert_text_constraints_checked("sender", "recipients", "subject");

  // con defaults, por favor
  set_filter_text("foo");
  assert_messages_in_view([setSenderFoo, setRecipientsFoo, setSubjectFoo]);
  // note: we sequence the changes in the list so there is always at least one
  //  dude selected.  selecting down to nothing has potential UI implications
  //  we don't want this test to get affected by.
  // sender only
  toggle_text_constraints("recipients", "subject");
  assert_messages_in_view(setSenderFoo);
  // recipients only
  toggle_text_constraints("recipients", "sender");
  assert_messages_in_view(setRecipientsFoo);
  // subject only
  toggle_text_constraints("subject", "recipients");
  assert_messages_in_view(setSubjectFoo);
  // body only
  toggle_text_constraints("body", "subject");
  assert_messages_in_view(setBodyFoo);
  // everybody
  toggle_text_constraints("sender", "recipients", "subject");
  assert_messages_in_view([
    setSenderFoo,
    setRecipientsFoo,
    setSubjectFoo,
    setBodyFoo,
  ]);

  // sanity check non-matching
  set_filter_text("notgonnamatchevercauseisayso");
  assert_messages_in_view([]);
  // disable body, still should get nothing
  toggle_text_constraints("body");
  assert_messages_in_view([]);

  // (we are leaving with the defaults once again active)
  assert_text_constraints_checked("sender", "recipients", "subject");
  teardownTest();
});

/**
 * Verify that the multi-word logic is actually splitting the words into
 *  different terms and that the terms can match in different predicates.
 *  This means that given "foo bar" we should be able to match "bar foo" in
 *  a subject and "foo" in the sender and "bar" in the recipient.  And that
 *  constitutes sufficient positive coverage, although we also want to make
 *  sure that just a single term match is insufficient.
 */
add_task(function test_filter_text_multi_word() {
  let folder = create_folder("QuickFilterBarTextMultiWord");

  let whoFoo = ["foo", "zabba@madeup.invalid"];
  let whoBar = ["zabba", "bar@madeup.invalid"];
  let [
    ,
    setPeepMatch,
    setSubjReverse,
  ] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1, from: whoFoo, to: [whoBar] },
    { count: 1, subject: "bar foo" },
    { count: 1, from: whoFoo },
  ]);
  be_in_folder(folder);

  // (precondition)
  assert_text_constraints_checked("sender", "recipients", "subject");

  set_filter_text("foo bar");
  assert_messages_in_view([setPeepMatch, setSubjReverse]);
  teardownTest();
});

/**
 * Verify that the quickfilter bar has OR functionality using
 * | (Pipe character) - Bug 586131
 */
add_task(function test_filter_or_operator() {
  let folder = create_folder("QuickFilterBarOrOperator");

  let whoFoo = ["foo", "zabba@madeup.invalid"];
  let whoBar = ["zabba", "bar@madeup.invalid"];
  let whoTest = ["test", "test@madeup.invalid"];
  let [
    setInert,
    setSenderFoo,
    setToBar,
    ,
    ,
    setSubject3,
    setMail1,
  ] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1, from: whoFoo },
    { count: 1, to: [whoBar] },
    { count: 1, subject: "foo bar" },
    { count: 1, subject: "bar test" },
    { count: 1, subject: "test" },
    { count: 1, to: [whoTest], subject: "logic" },
    { count: 1, from: whoFoo, to: [whoBar], subject: "test" },
  ]);
  be_in_folder(folder);

  assert_text_constraints_checked("sender", "recipients", "subject");
  set_filter_text("foo | bar");
  assert_messages_not_in_view([setInert, setSubject3, setMail1]);

  set_filter_text("test | bar");
  assert_messages_not_in_view([setInert, setSenderFoo]);

  set_filter_text("foo | test");
  assert_messages_not_in_view([setInert, setToBar]);

  // consists of leading and trailing spaces and tab character.
  set_filter_text("test     |   foo bar");
  assert_messages_not_in_view([
    setInert,
    setSenderFoo,
    setToBar,
    setSubject3,
    setMail1,
  ]);

  set_filter_text("test | foo  bar |logic");
  assert_messages_not_in_view([setInert, setSenderFoo, setToBar, setSubject3]);
  teardownTest();
});

/**
 * Make sure that when dropping all constraints on toggle off or changing
 *  folders that we persist/propagate the state of the
 *  sender/recipients/subject/body toggle buttons.
 */
add_task(function test_filter_text_constraints_propagate() {
  let whoFoo = ["foo", "zabba@madeup.invalid"];
  let whoBar = ["zabba", "bar@madeup.invalid"];

  let folderOne = create_folder("QuickFilterBarTextPropagate1");
  let [setSubjFoo, setWhoFoo] = MessageInjection.make_new_sets_in_folder(
    folderOne,
    [
      { count: 1, subject: "foo" },
      { count: 1, from: whoFoo },
    ]
  );
  let folderTwo = create_folder("QuickFilterBarTextPropagate2");
  let [, setWhoBar] = MessageInjection.make_new_sets_in_folder(folderTwo, [
    { count: 1, subject: "bar" },
    { count: 1, from: whoBar },
  ]);

  be_in_folder(folderOne);
  set_filter_text("foo");
  // (precondition)
  assert_text_constraints_checked("sender", "recipients", "subject");
  assert_messages_in_view([setSubjFoo, setWhoFoo]);

  // -- drop subject, close bar to reset, make sure it sticks
  toggle_text_constraints("subject");
  assert_messages_in_view([setWhoFoo]);

  toggle_quick_filter_bar();
  toggle_quick_filter_bar();

  set_filter_text("foo");
  assert_messages_in_view([setWhoFoo]);
  assert_text_constraints_checked("sender", "recipients");

  // -- now change folders and make sure the settings stick
  be_in_folder(folderTwo);
  set_filter_text("bar");
  assert_messages_in_view([setWhoBar]);
  assert_text_constraints_checked("sender", "recipients");
  teardownTest();
});

/**
 * Here is what the results label does:
 * - No filter active: results label is not visible.
 * - Filter active, messages: it says the number of messages.
 * - Filter active, no messages: it says there are no messages.
 *
 * Additional nuances:
 * - The count needs to update as the user deletes messages or what not.
 */
add_task(function test_results_label() {
  let folder = create_folder("QuickFilterBarResultsLabel");
  let [
    setImmortal,
    setMortal,
    setGoldfish,
  ] = MessageInjection.make_new_sets_in_folder(folder, [
    { count: 1 },
    { count: 1 },
    { count: 1 },
  ]);

  be_in_folder(folder);

  // no filter, the label should not be visible
  if (mc.e("qfb-results-label").visible) {
    throw new Error("results label should not be visible, yo! mad impropah!");
  }

  toggle_boolean_constraints("unread");
  assert_messages_in_view([setImmortal, setMortal, setGoldfish]);
  assert_results_label_count(3);

  MessageInjection.async_delete_messages(setGoldfish);
  assert_results_label_count(2);

  MessageInjection.async_delete_messages(setMortal);
  assert_results_label_count(1);

  MessageInjection.async_delete_messages(setImmortal);
  assert_results_label_count(0);
  teardownTest();
});

function teardownTest() {
  clear_constraints();
  // make it visible if it's not
  if (mc.e("quick-filter-bar").collapsed) {
    toggle_quick_filter_bar();
  }

  Assert.report(
    false,
    undefined,
    undefined,
    "Test ran to completion successfully"
  );
}
