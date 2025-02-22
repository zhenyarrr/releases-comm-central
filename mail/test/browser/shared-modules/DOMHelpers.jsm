/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = [
  "assert_element_visible",
  "element_visible_recursive",
  "assert_element_not_visible",
  "wait_for_element",
  "assert_next_nodes",
  "assert_previous_nodes",
  "wait_for_element_enabled",
  "check_element_visible",
  "wait_for_element_visible",
  "wait_for_element_invisible",
  "collapse_panes",
];

const lazy = {};

ChromeUtils.defineModuleGetter(
  lazy,
  "mc",
  "resource://testing-common/mozmill/FolderDisplayHelpers.jsm"
);

var { Assert } = ChromeUtils.importESModule(
  "resource://testing-common/Assert.sys.mjs"
);

var utils = ChromeUtils.import("resource://testing-common/mozmill/utils.jsm");

/**
 * This function takes either a string or an elementlibs.Elem, and returns
 * whether it is hidden or not (simply by poking at its hidden property). It
 * doesn't try to do anything smart, like is it not into view, or whatever.
 *
 * @param aElt The element to query.
 * @returns Whether the element is visible or not.
 */
function element_visible(aElt) {
  let e;
  if (typeof aElt == "string") {
    e = lazy.mc.window.document.getElementById(aElt);
  } else {
    e = aElt;
  }
  return !e.hidden;
}

/**
 * Assert that en element's visible.
 *
 * @param aElt The element, an ID or an elementlibs.Elem
 * @param aWhy The error message in case of failure
 */
function assert_element_visible(aElt, aWhy) {
  Assert.ok(element_visible(aElt), aWhy);
}

/**
 * Returns if a element is visible by traversing all parent elements and check
 * that all are visible.
 *
 * @param aElem The element to be checked
 */
function element_visible_recursive(aElem) {
  if (aElem.hidden || aElem.collapsed) {
    return false;
  }
  let parent = aElem.parentNode;
  if (parent == null) {
    return true;
  }

  // #tabpanelcontainer and its parent #tabmail-tabbox have the same selectedPanel.
  // Don't ask me why, it's just the way it is.
  if (
    "selectedPanel" in parent &&
    parent.selectedPanel != aElem &&
    aElem.id != "tabpanelcontainer"
  ) {
    return false;
  }
  return element_visible_recursive(parent);
}

/**
 * Assert that en element's not visible.
 *
 * @param aElt The element, an ID or an elementlibs.Elem
 * @param aWhy The error message in case of failure
 */
function assert_element_not_visible(aElt, aWhy) {
  Assert.ok(!element_visible(aElt), aWhy);
}

/**
 * Wait for and return an element matching a particular CSS selector.
 *
 * @param aParent the node to begin searching from
 * @param aSelector the CSS selector to search with
 */
function wait_for_element(aParent, aSelector) {
  let target = null;
  utils.waitFor(function () {
    target = aParent.querySelector(aSelector);
    return target != null;
  }, "Timed out waiting for a target for selector: " + aSelector);

  return target;
}

/**
 * Given some starting node aStart, ensure that aStart and the aNum next
 * siblings of aStart are nodes of type aNodeType.
 *
 * @param aNodeType the type of node to look for, example: "br".
 * @param aStart the first node to check.
 * @param aNum the number of sibling br nodes to check for.
 */
function assert_next_nodes(aNodeType, aStart, aNum) {
  let node = aStart;
  for (let i = 0; i < aNum; ++i) {
    node = node.nextSibling;
    if (node.localName != aNodeType) {
      throw new Error(
        "The node should be followed by " +
          aNum +
          " nodes of " +
          "type " +
          aNodeType
      );
    }
  }
  return node;
}

/**
 * Given some starting node aStart, ensure that aStart and the aNum previous
 * siblings of aStart are nodes of type aNodeType.
 *
 * @param aNodeType the type of node to look for, example: "br".
 * @param aStart the first node to check.
 * @param aNum the number of sibling br nodes to check for.
 */
function assert_previous_nodes(aNodeType, aStart, aNum) {
  let node = aStart;
  for (let i = 0; i < aNum; ++i) {
    node = node.previousSibling;
    if (node.localName != aNodeType) {
      throw new Error(
        "The node should be preceded by " +
          aNum +
          " nodes of " +
          "type " +
          aNodeType
      );
    }
  }
  return node;
}

/**
 * Given some element, wait for that element to be enabled or disabled,
 * depending on the value of aEnabled.
 *
 * @param aController the controller parent of the element
 * @param aNode the element to check.
 * @param aEnabled whether or not the node should be enabled, or disabled.
 */
function wait_for_element_enabled(aController, aElement, aEnabled) {
  if (!("disabled" in aElement)) {
    throw new Error(
      "Element does not appear to have disabled property; id=" + aElement.id
    );
  }

  utils.waitFor(
    () => aElement.disabled != aEnabled,
    "Element should have eventually been " +
      (aEnabled ? "enabled" : "disabled") +
      "; id=" +
      aElement.id
  );
}

function check_element_visible(aController, aId) {
  let element = aController.window.document.getElementById(aId);
  if (!element) {
    return false;
  }

  while (element) {
    if (
      element.hidden ||
      element.collapsed ||
      element.clientWidth == 0 ||
      element.clientHeight == 0 ||
      aController.window.getComputedStyle(element).display == "none"
    ) {
      return false;
    }
    element = element.parentElement;
  }
  return true;
}

/**
 * Wait for a particular element to become fully visible.
 *
 * @param aController  the controller parent of the element
 * @param aId          id of the element to wait for
 */
function wait_for_element_visible(aController, aId) {
  utils.waitFor(function () {
    return check_element_visible(aController, aId);
  }, "Timed out waiting for element with ID=" + aId + " to become visible");
}

/**
 * Wait for a particular element to become fully invisible.
 *
 * @param aController  the controller parent of the element
 * @param aId          id of the element to wait for
 */
function wait_for_element_invisible(aController, aId) {
  utils.waitFor(function () {
    return !check_element_visible(aController, aId);
  }, "Timed out waiting for element with ID=" + aId + " to become invisible");
}

/**
 * Helper to collapse panes separated by splitters. If aElement is a splitter
 * itself, then this splitter is collapsed, otherwise all splitters that are
 * direct children of aElement are collapsed.
 *
 * @param aElement              The splitter or container
 * @param aShouldBeCollapsed    If true, collapse the pane
 */
function collapse_panes(aElement, aShouldBeCollapsed) {
  let state = aShouldBeCollapsed ? "collapsed" : "open";
  if (aElement.localName == "splitter") {
    aElement.setAttribute("state", state);
  } else {
    for (let n of aElement.childNodes) {
      if (n.localName == "splitter") {
        n.setAttribute("state", state);
      }
    }
  }
  // Spin the event loop once to let other window elements redraw.
  utils.sleep(50);
}
