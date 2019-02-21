/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Atul Varma <atul@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

(function(global) {
  const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");

   var exports = {};

   var systemPrincipal = Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal);

   function resolvePrincipal(principal, defaultPrincipal) {
     if (principal === undefined)
       return defaultPrincipal;
     if (principal == "system")
       return systemPrincipal;
     return principal;
   }

   // The base URI to we use when we're given relative URLs, if any.
   var baseURI = null;
   if (global.window)
     baseURI = Services.io.newURI(global.location.href);
   exports.baseURI = baseURI;

   // The "parent" chrome URI to use if we're loading code that
   // needs chrome privileges but may not have a filename that
   // matches any of SpiderMonkey's defined system filename prefixes.
   // The latter is needed so that wrappers can be automatically
   // made for the code. For more information on this, see
   // bug 418356:
   //
   // https://bugzilla.mozilla.org/show_bug.cgi?id=418356
   var parentChromeURIString;
   if (baseURI)
     // We're being loaded from a chrome-privileged document, so
     // use its URL as the parent string.
     parentChromeURIString = baseURI.spec;
   else
     // We're being loaded from a chrome-privileged JS module or
     // SecurableModule, so use its filename (which may itself
     // contain a reference to a parent).
     parentChromeURIString = Components.stack.filename;

   function maybeParentifyFilename(filename) {
     var doParentifyFilename = true;
     try {
       // TODO: Ideally we should just make
       // nsIChromeRegistry.wrappersEnabled() available from script
       // and use it here. Until that's in the platform, though,
       // we'll play it safe and parentify the filename unless
       // we're absolutely certain things will be ok if we don't.
       var filenameURI = Services.io.newURI(filename, null, baseURI);
       if (filenameURI.scheme == "chrome" &&
           filenameURI.pathQueryRef.indexOf("/content/") == 0)
         // Content packages will always have wrappers made for them;
         // if automatic wrappers have been disabled for the
         // chrome package via a chrome manifest flag, then
         // this still works too, to the extent that the
         // content package is insecure anyways.
         doParentifyFilename = false;
     } catch (e) {}
     if (doParentifyFilename)
       return parentChromeURIString + " -> " + filename;
     return filename;
   }

   function getRootDir(urlStr) {
     // TODO: This feels hacky, and like there will be edge cases.
     return urlStr.slice(0, urlStr.lastIndexOf("/") + 1);
   }

   exports.SandboxFactory = function(defaultPrincipal) {
     // Unless specified otherwise, use a principal with limited
     // privileges.
     this._defaultPrincipal = resolvePrincipal(defaultPrincipal, "http://www.mozilla.org");
   };

   exports.SandboxFactory.prototype = {
     createSandbox(options) {
       var principal = resolvePrincipal(options.principal,
                                        this._defaultPrincipal);

       return {
         _sandbox: new Cu.Sandbox(principal, { wantGlobalProperties: ["ChromeUtils"] }),
         _principal: principal,
         get globalScope() {
           return this._sandbox;
         },
         defineProperty(name, value) {
           this._sandbox[name] = value;
         },
         getProperty(name) {
           return this._sandbox[name];
         },
         evaluate(options) {
           if (typeof(options) == "string")
             options = {contents: options};
           options = {__proto__: options};
           if (typeof(options.contents) != "string")
             throw new Error("Expected string for options.contents");
           if (options.lineNo === undefined)
             options.lineNo = 1;
           if (options.jsVersion === undefined)
             options.jsVersion = "1.8";
           if (typeof(options.filename) != "string")
             options.filename = "<string>";

           if (this._principal == systemPrincipal)
             options.filename = maybeParentifyFilename(options.filename);

           return Cu.evalInSandbox(options.contents,
                                   this._sandbox,
                                   options.jsVersion,
                                   options.filename,
                                   options.lineNo);
         },
       };
     },
   };

   exports.Loader = function(options) {
     options = {__proto__: options};
     if (options.fs === undefined) {
       var rootPaths = options.rootPath || options.rootPaths;
       if (rootPaths) {
         if (rootPaths.constructor.name != "Array")
           rootPaths = [rootPaths];
         var fses = rootPaths.map(path => new exports.LocalFileSystem(path));
         options.fs = new exports.CompositeFileSystem(fses);
       } else {
         options.fs = new exports.LocalFileSystem();
       }
     }
     if (options.sandboxFactory === undefined)
       options.sandboxFactory = new exports.SandboxFactory(
         options.defaultPrincipal
       );
     if (options.modules === undefined)
       options.modules = {};
     if (options.globals === undefined)
       options.globals = {};

     this.fs = options.fs;
     this.sandboxFactory = options.sandboxFactory;
     this.sandboxes = {};
     this.modules = options.modules;
     this.globals = options.globals;
   };

   exports.Loader.prototype = {
     _makeRequire(rootDir) {
       var self = this;
       return function(module) {
         if (module == "chrome") {
           var chrome = {
             Cc, Ci, Cu, Cr,
             Cm: Components.manager,
             components: Components,
           };
           return chrome;
         }
         var path = self.fs.resolveModule(rootDir, module);
         if (!path)
           throw new Error('Module "' + module + '" not found');
         if (!(path in self.modules)) {
           var options = self.fs.getFile(path);
           if (options.filename === undefined)
             options.filename = path;

           var sandbox = self.sandboxFactory.createSandbox(options);
           self.sandboxes[path] = sandbox;
           for (let name in self.globals) {
             sandbox.defineProperty(name, self.globals[name]);
           }
           sandbox.defineProperty("require", self._makeRequire(path));
           sandbox.evaluate("var exports = {};");
           let ES5 = self.modules.es5;
           if (ES5) {
             let { Object, Array, Function } = sandbox.globalScope;
             ES5.init(Object, Array, Function);
           }
           self.modules[path] = sandbox.getProperty("exports");
           sandbox.evaluate(options);
         }
         return self.modules[path];
       };
     },

     // This is only really used by unit tests and other
     // development-related facilities, allowing access to symbols
     // defined in the global scope of a module.
     findSandboxForModule(module) {
       var path = this.fs.resolveModule(null, module);
       if (!path)
         throw new Error('Module "' + module + '" not found');
       if (!(path in this.sandboxes))
         this.require(module);
       if (!(path in this.sandboxes))
         throw new Error("Internal error: path not in sandboxes: " +
                         path);
       return this.sandboxes[path];
     },

     require(module) {
       return (this._makeRequire(null))(module);
     },

     runScript(options, extraOutput) {
       if (typeof(options) == "string")
         options = {contents: options};
       options = {__proto__: options};
       var sandbox = this.sandboxFactory.createSandbox(options);
       if (extraOutput)
         extraOutput.sandbox = sandbox;
       for (let name in this.globals) {
         sandbox.defineProperty(name, this.globals[name]);
       }
       sandbox.defineProperty("require", this._makeRequire(null));
       return sandbox.evaluate(options);
     },
   };

   exports.CompositeFileSystem = function(fses) {
     this.fses = fses;
     this._pathMap = {};
   };

   exports.CompositeFileSystem.prototype = {
     resolveModule(base, path) {
       for (var i = 0; i < this.fses.length; i++) {
         var fs = this.fses[i];
         var absPath = fs.resolveModule(base, path);
         if (absPath) {
           this._pathMap[absPath] = fs;
           return absPath;
         }
       }
       return null;
     },
     getFile(path) {
       return this._pathMap[path].getFile(path);
     },
   };

   exports.LocalFileSystem = function(root) {
     if (root === undefined) {
       if (!baseURI)
         throw new Error("Need a root path for module filesystem");
       root = baseURI;
     }
     if (typeof(root) == "string")
       root = Services.io.newURI(root, null, baseURI);
     if (root instanceof Ci.nsIFile)
       root = Services.io.newFileURI(root);
     if (!(root instanceof Ci.nsIURI))
       throw new Error("Expected nsIFile, nsIURI, or string for root");

     this.root = root.spec;
     this._rootURI = root;
     this._rootURIDir = getRootDir(root.spec);
   };

   exports.LocalFileSystem.prototype = {
     resolveModule(base, path) {
       path = path + ".js";

       var baseURI;
       if (!base)
         baseURI = this._rootURI;
       else
         baseURI = Services.io.newURI(base);
       var newURI = Services.io.newURI(path, null, baseURI);
       var channel = Services.io.newChannelFromURI(newURI,
                                            null,
                                            Services.scriptSecurityManager.getSystemPrincipal(),
                                            null,
                                            Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_DATA_IS_NULL,
                                            Ci.nsIContentPolicy.TYPE_OTHER);
       try {
         channel.open().close();
       } catch (e) {
         if (e.result != Cr.NS_ERROR_FILE_NOT_FOUND) {
           throw e;
         }
         return null;
       }
       return newURI.spec;
     },
     getFile(path) {
       var channel = Services.io.newChannel2(path,
                                     null,
                                     null,
                                     null,
                                     Services.scriptSecurityManager.getSystemPrincipal(),
                                     null,
                                     Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_DATA_IS_NULL,
                                     Ci.nsIContentPolicy.TYPE_OTHER);
       var iStream = channel.open();
       var ciStream = Cc["@mozilla.org/intl/converter-input-stream;1"].
                      createInstance(Ci.nsIConverterInputStream);
       var bufLen = 0x8000;
       ciStream.init(iStream, "UTF-8", bufLen,
                     Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
       var chunk = {};
       var data = "";
       while (ciStream.readString(bufLen, chunk) > 0)
         data += chunk.value;
       ciStream.close();
       iStream.close();
       return {contents: data};
     },
   };

   if (global.window) {
     // We're being loaded in a chrome window, or a web page with
     // UniversalXPConnect privileges.
     global.SecurableModule = exports;
   } else if (global.exports) {
     // We're being loaded in a SecurableModule.
     for (let name in exports) {
       global.exports[name] = exports[name];
     }
   } else {
     // We're being loaded in a JS module.
     global.EXPORTED_SYMBOLS = [];
     for (let name in exports) {
       global.EXPORTED_SYMBOLS.push(name);
       global[name] = exports[name];
     }
   }
 })(this);
