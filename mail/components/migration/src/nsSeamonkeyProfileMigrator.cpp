/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
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
 * The Original Code is The Mail Profile Migrator.
 *
 * The Initial Developer of the Original Code is Ben Goodger.
 * Portions created by the Initial Developer are Copyright (C) 2004
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Ben Goodger <ben@bengoodger.com>
 *  Scott MacGregor <mscott@mozilla.org>
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

#include "nsMailProfileMigratorUtils.h"
#include "nsDirectoryServiceDefs.h"
#include "nsIPrefLocalizedString.h"
#include "nsIPrefService.h"
#include "nsArrayUtils.h"
#include "nsISupportsPrimitives.h"
#include "nsNetCID.h"
#include "nsNetUtil.h"
#include "nsSeamonkeyProfileMigrator.h"
#include "nsAppDirectoryServiceDefs.h"

// Mail specific folder paths
#define MAIL_DIR_50_NAME             NS_LITERAL_STRING("Mail")
#define IMAP_MAIL_DIR_50_NAME        NS_LITERAL_STRING("ImapMail")
#define NEWS_DIR_50_NAME             NS_LITERAL_STRING("News")


///////////////////////////////////////////////////////////////////////////////
// nsSeamonkeyProfileMigrator
#define FILE_NAME_JUNKTRAINING    NS_LITERAL_STRING("training.dat")
#define FILE_NAME_PERSONALDICTIONARY NS_LITERAL_STRING("persdict.dat")
#define FILE_NAME_PERSONAL_ADDRESSBOOK NS_LITERAL_STRING("abook.mab")
#define FILE_NAME_MAILVIEWS       NS_LITERAL_STRING("mailviews.dat")
#define FILE_NAME_CERT8DB         NS_LITERAL_STRING("cert8.db")
#define FILE_NAME_KEY3DB          NS_LITERAL_STRING("key3.db")
#define FILE_NAME_SECMODDB        NS_LITERAL_STRING("secmod.db")
#define FILE_NAME_MIMETYPES       NS_LITERAL_STRING("mimeTypes.rdf")
#define FILE_NAME_PREFS           NS_LITERAL_STRING("prefs.js")
#define FILE_NAME_USER_PREFS      NS_LITERAL_STRING("user.js")

struct PrefBranchStruct {
  char*         prefName;
  PRInt32       type;
  union {
    char*       stringValue;
    PRInt32     intValue;
    bool        boolValue;
    PRUnichar*  wstringValue;
  };
};

NS_IMPL_ISUPPORTS2(nsSeamonkeyProfileMigrator, nsIMailProfileMigrator, nsITimerCallback)


nsSeamonkeyProfileMigrator::nsSeamonkeyProfileMigrator()
{
}

nsSeamonkeyProfileMigrator::~nsSeamonkeyProfileMigrator()
{
}

///////////////////////////////////////////////////////////////////////////////
// nsIMailProfileMigrator

NS_IMETHODIMP
nsSeamonkeyProfileMigrator::Migrate(PRUint16 aItems, nsIProfileStartup* aStartup, const PRUnichar* aProfile)
{
  nsresult rv = NS_OK;
  bool aReplace = aStartup ? true : false;

  if (!mTargetProfile) {
    GetProfilePath(aStartup, mTargetProfile);
    if (!mTargetProfile) return NS_ERROR_FAILURE;
  }
  if (!mSourceProfile) {
    GetSourceProfile(aProfile);
    if (!mSourceProfile)
      return NS_ERROR_FAILURE;
  }

  NOTIFY_OBSERVERS(MIGRATION_STARTED, nsnull);

  COPY_DATA(CopyPreferences,  aReplace, nsIMailProfileMigrator::SETTINGS);

  // fake notifications for things we've already imported as part of CopyPreferences
  COPY_DATA(DummyCopyRoutine, aReplace, nsIMailProfileMigrator::ACCOUNT_SETTINGS);
  COPY_DATA(DummyCopyRoutine, aReplace, nsIMailProfileMigrator::NEWSDATA);

  // copy junk mail training file
  COPY_DATA(CopyJunkTraining, aReplace, nsIMailProfileMigrator::JUNKTRAINING);
  COPY_DATA(CopyPasswords,    aReplace, nsIMailProfileMigrator::PASSWORDS);

  // the last thing to do is to actually copy over any mail folders we have marked for copying
  // we want to do this last and it will be asynchronous so the UI doesn't freeze up while we perform
  // this potentially very long operation.

  nsAutoString index;
  index.AppendInt(nsIMailProfileMigrator::MAILDATA);
  NOTIFY_OBSERVERS(MIGRATION_ITEMBEFOREMIGRATE, index.get());

  // Generate the max progress value now that we know all of the files we need to copy
  PRUint32 count = mFileCopyTransactions.Length();
  for (PRUint32 i = 0; i < count; ++i)
  {
    fileTransactionEntry fileTransaction = mFileCopyTransactions.ElementAt(i);
    PRInt64 fileSize;
    fileTransaction.srcFile->GetFileSize(&fileSize);
    LL_ADD(mMaxProgress, mMaxProgress, fileSize);
  }

  CopyNextFolder();

  return rv;
}

NS_IMETHODIMP
nsSeamonkeyProfileMigrator::GetMigrateData(const PRUnichar* aProfile,
                                           bool aReplace,
                                           PRUint16* aResult)
{
  *aResult = 0;

  if (!mSourceProfile) {
    GetSourceProfile(aProfile);
    if (!mSourceProfile)
      return NS_ERROR_FILE_NOT_FOUND;
  }

  MigrationData data[] = { { ToNewUnicode(FILE_NAME_PREFS),
                             nsIMailProfileMigrator::SETTINGS,
                             true },
                           { ToNewUnicode(FILE_NAME_JUNKTRAINING),
                             nsIMailProfileMigrator::JUNKTRAINING,
                             true },
                          };

  // Frees file name strings allocated above.
  GetMigrateDataFromArray(data, sizeof(data)/sizeof(MigrationData),
                          aReplace, mSourceProfile, aResult);

  // Now locate passwords
  nsCString signonsFileName;
  GetSignonFileName(aReplace, getter_Copies(signonsFileName));

  if (!signonsFileName.IsEmpty()) {
    nsAutoString fileName;
    CopyASCIItoUTF16(signonsFileName, fileName);
    nsCOMPtr<nsIFile> sourcePasswordsFile;
    mSourceProfile->Clone(getter_AddRefs(sourcePasswordsFile));
    sourcePasswordsFile->Append(fileName);

    bool exists;
    sourcePasswordsFile->Exists(&exists);
    if (exists)
      *aResult |= nsIMailProfileMigrator::PASSWORDS;
  }

  // add some extra migration fields for things we also migrate
  *aResult |= nsIMailProfileMigrator::ACCOUNT_SETTINGS
           | nsIMailProfileMigrator::MAILDATA
           | nsIMailProfileMigrator::NEWSDATA
           | nsIMailProfileMigrator::ADDRESSBOOK_DATA;

  return NS_OK;
}

NS_IMETHODIMP
nsSeamonkeyProfileMigrator::GetSourceProfiles(nsIArray** aResult)
{
  if (!mProfileNames && !mProfileLocations) {
    nsresult rv;
    mProfileNames = do_CreateInstance(NS_ARRAY_CONTRACTID, &rv);
    if (NS_FAILED(rv))
      return rv;

    mProfileLocations = do_CreateInstance(NS_ARRAY_CONTRACTID, &rv);
    if (NS_FAILED(rv))
      return rv;

    // Fills mProfileNames and mProfileLocations
    FillProfileDataFromSeamonkeyRegistry();
  }

  NS_IF_ADDREF(*aResult = mProfileNames);
  return NS_OK;
}

///////////////////////////////////////////////////////////////////////////////
// nsSeamonkeyProfileMigrator

nsresult
nsSeamonkeyProfileMigrator::GetSourceProfile(const PRUnichar* aProfile)
{
  PRUint32 count;
  mProfileNames->GetLength(&count);
  for (PRUint32 i = 0; i < count; ++i) {
    nsCOMPtr<nsISupportsString> str(do_QueryElementAt(mProfileNames, i));
    nsString profileName;
    str->GetData(profileName);
    if (profileName.Equals(aProfile)) {
      mSourceProfile = do_QueryElementAt(mProfileLocations, i);
      break;
    }
  }

  return NS_OK;
}

nsresult
nsSeamonkeyProfileMigrator::FillProfileDataFromSeamonkeyRegistry()
{
  // Find the Seamonkey Registry
  nsCOMPtr<nsIProperties> fileLocator(
    do_GetService("@mozilla.org/file/directory_service;1"));
  nsCOMPtr<nsILocalFile> seamonkeyData;
#undef EXTRA_PREPEND

#ifdef XP_WIN
#define NEW_FOLDER "SeaMonkey"
#define EXTRA_PREPEND "Mozilla"

  fileLocator->Get(NS_WIN_APPDATA_DIR, NS_GET_IID(nsILocalFile),
                   getter_AddRefs(seamonkeyData));
  NS_ENSURE_TRUE(seamonkeyData, NS_ERROR_FAILURE);

#elif defined(XP_MACOSX)
#define NEW_FOLDER "SeaMonkey"
#define EXTRA_PREPEND "Application Support"
  fileLocator->Get(NS_MAC_USER_LIB_DIR, NS_GET_IID(nsILocalFile),
                   getter_AddRefs(seamonkeyData));
  NS_ENSURE_TRUE(seamonkeyData, NS_ERROR_FAILURE);

#elif defined(XP_UNIX)
#define NEW_FOLDER "seamonkey"
#define EXTRA_PREPEND ".mozilla"
  fileLocator->Get(NS_UNIX_HOME_DIR, NS_GET_IID(nsILocalFile),
                   getter_AddRefs(seamonkeyData));
  NS_ENSURE_TRUE(seamonkeyData, NS_ERROR_FAILURE);

#elif defined(XP_OS2)
#define NEW_FOLDER "SeaMonkey"
#define EXTRA_PREPEND "Mozilla"

  fileLocator->Get(NS_OS2_HOME_DIR, NS_GET_IID(nsILocalFile),
                   getter_AddRefs(seamonkeyData));
  NS_ENSURE_TRUE(seamonkeyData, NS_ERROR_FAILURE);

#else
  // On other OS just abort.
  return NS_ERROR_FAILURE;
#endif

  nsCOMPtr<nsIFile> newSeamonkeyData;
  seamonkeyData->Clone(getter_AddRefs(newSeamonkeyData));
  NS_ENSURE_TRUE(newSeamonkeyData, NS_ERROR_FAILURE);

#ifdef EXTRA_PREPEND
  newSeamonkeyData->Append(NS_LITERAL_STRING(EXTRA_PREPEND));
#endif
  newSeamonkeyData->Append(NS_LITERAL_STRING(NEW_FOLDER));

  nsCOMPtr<nsILocalFile> newSmDataLocal(do_QueryInterface(newSeamonkeyData));
  NS_ENSURE_TRUE(newSmDataLocal, NS_ERROR_FAILURE);

  nsresult rv = GetProfileDataFromProfilesIni(newSmDataLocal,
                                              mProfileNames,
                                              mProfileLocations);

  return rv;
}

static
nsSeamonkeyProfileMigrator::PrefTransform gTransforms[] = {


  MAKESAMETYPEPREFTRANSFORM("signon.SignonFileName",                    String),
  MAKESAMETYPEPREFTRANSFORM("mailnews.headers.showUserAgent",           Bool),
  MAKESAMETYPEPREFTRANSFORM("mailnews.headers.showOrganization",        Bool),
  MAKESAMETYPEPREFTRANSFORM("mail.collect_addressbook",                 String),
  MAKESAMETYPEPREFTRANSFORM("mail.collect_email_address_outgoing",      Bool),
  MAKESAMETYPEPREFTRANSFORM("mail.wrap_long_lines",                     Bool),
  MAKESAMETYPEPREFTRANSFORM("mailnews.customHeaders",                   String),
  MAKESAMETYPEPREFTRANSFORM("mail.default_html_action",                 Int),
  MAKESAMETYPEPREFTRANSFORM("mail.forward_message_mode",                Int),
  MAKESAMETYPEPREFTRANSFORM("mail.SpellCheckBeforeSend",                Bool),
  MAKESAMETYPEPREFTRANSFORM("mail.warn_on_send_accel_key",              Bool),
  MAKESAMETYPEPREFTRANSFORM("mailnews.html_domains",                    String),
  MAKESAMETYPEPREFTRANSFORM("mailnews.plaintext_domains",               String),
  MAKESAMETYPEPREFTRANSFORM("mailnews.headers.showUserAgent",           Bool),
  MAKESAMETYPEPREFTRANSFORM("mailnews.headers.showOrganization",        Bool),
  MAKESAMETYPEPREFTRANSFORM("mail.biff.play_sound",                     Bool),
  MAKESAMETYPEPREFTRANSFORM("mail.biff.play_sound.type",                Int),
  MAKESAMETYPEPREFTRANSFORM("mail.biff.play_sound.url",                 String),
  MAKESAMETYPEPREFTRANSFORM("mail.biff.show_alert",                     Bool),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.type",                       Int),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.http",                       String),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.http_port",                  Int),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.ftp",                        String),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.ftp_port",                   Int),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.ssl",                        String),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.ssl_port",                   Int),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.socks",                      String),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.socks_port",                 Int),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.no_proxies_on",              String),
  MAKESAMETYPEPREFTRANSFORM("network.proxy.autoconfig_url",             String),

  MAKESAMETYPEPREFTRANSFORM("mail.accountmanager.accounts",             String),
  MAKESAMETYPEPREFTRANSFORM("mail.accountmanager.defaultaccount",       String),
  MAKESAMETYPEPREFTRANSFORM("mail.accountmanager.localfoldersserver",   String),
  MAKESAMETYPEPREFTRANSFORM("mail.smtp.defaultserver",                  String),
  MAKESAMETYPEPREFTRANSFORM("mail.smtpservers",                         String),

  MAKESAMETYPEPREFTRANSFORM("msgcompose.font_face",                     String),
  MAKESAMETYPEPREFTRANSFORM("msgcompose.font_size",                     String),
  MAKESAMETYPEPREFTRANSFORM("msgcompose.text_color",                    String),
  MAKESAMETYPEPREFTRANSFORM("msgcompose.background_color",              String),

  MAKEPREFTRANSFORM("mail.pane_config","mail.pane_config.dynamic", Int, Int)
};


nsresult
nsSeamonkeyProfileMigrator::TransformPreferences(const nsAString& aSourcePrefFileName,
                                                 const nsAString& aTargetPrefFileName)
{
  PrefTransform* transform;
  PrefTransform* end = gTransforms + sizeof(gTransforms)/sizeof(PrefTransform);

  // Load the source pref file
  nsCOMPtr<nsIPrefService> psvc(do_GetService(NS_PREFSERVICE_CONTRACTID));
  psvc->ResetPrefs();

  nsCOMPtr<nsIFile> sourcePrefsFile;
  mSourceProfile->Clone(getter_AddRefs(sourcePrefsFile));
  sourcePrefsFile->Append(aSourcePrefFileName);
  psvc->ReadUserPrefs(sourcePrefsFile);

  nsCOMPtr<nsIPrefBranch> branch(do_QueryInterface(psvc));
  for (transform = gTransforms; transform < end; ++transform)
    transform->prefGetterFunc(transform, branch);

  static const char* branchNames[] =
  {
    // Keep the three below first, or change the indexes below
    "mail.identity.",
    "mail.server.",
    "ldap_2.",
    "mail.account.",
    "mail.smtpserver.",
    "mailnews.labels.",
    "mailnews.tags."
  };

  // read in the various pref branch trees for accounts, identities, servers, etc.
  PBStructArray branches[NS_ARRAY_LENGTH(branchNames)];
  PRUint32 i;
  for (i = 0; i < NS_ARRAY_LENGTH(branchNames); ++i)
    ReadBranch(branchNames[i], psvc, branches[i]);

  // The signature file prefs may be paths to files in the seamonkey profile
  // path so we need to copy them over and fix these paths up before we write
  // them out to the new prefs.js.
  CopySignatureFiles(branches[0], psvc);

  // Certain mail prefs may actually be absolute paths instead of profile
  // relative paths we need to fix these paths up before we write them out to
  // the new prefs.js
  CopyMailFolders(branches[1], psvc);

  CopyAddressBookDirectories(branches[2], psvc);

  // Now that we have all the pref data in memory, load the target pref file,
  // and write it back out.
  psvc->ResetPrefs();

  // XXX Re-order this?

  for (transform = gTransforms; transform < end; ++transform)
    transform->prefSetterFunc(transform, branch);

  for (i = 0; i < NS_ARRAY_LENGTH(branchNames); i++)
    WriteBranch(branchNames[i], psvc, branches[i]);

  nsCOMPtr<nsIFile> targetPrefsFile;
  mTargetProfile->Clone(getter_AddRefs(targetPrefsFile));
  targetPrefsFile->Append(aTargetPrefFileName);
  psvc->SavePrefFile(targetPrefsFile);

  return NS_OK;
}

nsresult
nsSeamonkeyProfileMigrator::CopyAddressBookDirectories(PBStructArray &aLdapServers,
                                                       nsIPrefService* aPrefService)
{
  // each server has a pref ending with .filename. The value of that pref points to a profile which we
  // need to migrate.
  nsAutoString index;
  index.AppendInt(nsIMailProfileMigrator::ADDRESSBOOK_DATA);
  NOTIFY_OBSERVERS(MIGRATION_ITEMBEFOREMIGRATE, index.get());

  PRUint32 count = aLdapServers.Length();
  for (PRUint32 i = 0; i < count; ++i)
  {
    PrefBranchStruct* pref = aLdapServers.ElementAt(i);
    nsDependentCString prefName(pref->prefName);

    if (StringEndsWith(prefName, nsDependentCString(".filename")))
    {
      NS_ConvertUTF8toUTF16 fileName(pref->stringValue);
      CopyFile(fileName, fileName);
    }
    // we don't need to do anything to the fileName pref itself
  }

  NOTIFY_OBSERVERS(MIGRATION_ITEMAFTERMIGRATE, index.get());

  return NS_OK;
}


nsresult
nsSeamonkeyProfileMigrator::CopySignatureFiles(PBStructArray &aIdentities,
                                               nsIPrefService* aPrefService)
{
  nsresult rv = NS_OK;

  PRUint32 count = aIdentities.Length();
  for (PRUint32 i = 0; i < count; ++i)
  {
    PrefBranchStruct* pref = aIdentities.ElementAt(i);
    nsDependentCString prefName(pref->prefName);

    // a partial fix for bug #255043
    // if the user's signature file from seamonkey lives in the
    // seamonkey profile root, we'll copy it over to the new
    // thunderbird profile root and thenn set the pref to the new value
    // note, this doesn't work for multiple signatures that live
    // below the seamonkey profile root
    if (StringEndsWith(prefName, nsDependentCString(".sig_file")))
    {
      // turn the pref into a nsILocalFile
      nsCOMPtr<nsILocalFile> srcSigFile =
        do_CreateInstance(NS_LOCAL_FILE_CONTRACTID);
      srcSigFile->SetPersistentDescriptor(nsDependentCString(pref->stringValue));

      nsCOMPtr<nsIFile> targetSigFile;
      rv = mTargetProfile->Clone(getter_AddRefs(targetSigFile));
      NS_ENSURE_SUCCESS(rv, rv);

      // now make the copy
      bool exists;
      srcSigFile->Exists(&exists);
      if (exists)
      {
        nsAutoString leafName;
        srcSigFile->GetLeafName(leafName);
        srcSigFile->CopyTo(targetSigFile,leafName); // will fail if we've already copied a sig file here
        targetSigFile->Append(leafName);

        // now write out the new descriptor
        nsCAutoString descriptorString;
        nsCOMPtr<nsILocalFile> localFile = do_QueryInterface(targetSigFile);
        localFile->GetPersistentDescriptor(descriptorString);
        NS_Free(pref->stringValue);
        pref->stringValue = ToNewCString(descriptorString);
      }
    }
  }
  return NS_OK;
}

nsresult
nsSeamonkeyProfileMigrator::CopyMailFolders(PBStructArray &aMailServers,
                                            nsIPrefService* aPrefService)
{
  // Each server has a .directory pref which points to the location of the mail data
  // for that server. We need to do two things for that case...
  // (1) Fix up the directory path for the new profile
  // (2) copy the mail folder data from the source directory pref to the destination directory pref

  nsresult rv = NS_OK;

  PRUint32 count = aMailServers.Length();
  for (PRUint32 i = 0; i < count; ++i)
  {
    PrefBranchStruct* pref = aMailServers.ElementAt(i);
    nsDependentCString prefName(pref->prefName);

    if (StringEndsWith(prefName, NS_LITERAL_CSTRING(".directory-rel"))) {
      // When the directories are modified below, we may change the .directory
      // pref. As we don't have a pref branch to modify at this stage and set
      // up the relative folders properly, we'll just remove all the
      // *.directory-rel prefs. Mailnews will cope with this, creating them
      // when it first needs them.
      if (pref->type == nsIPrefBranch::PREF_STRING)
        NS_Free(pref->stringValue);

      aMailServers.RemoveElementAt(i);
      // Now decrease i and count to match the removed element
      --i;
      --count;
    }
    else if (StringEndsWith(prefName, nsDependentCString(".directory")))
    {
      // let's try to get a branch for this particular server to simplify things
      prefName.Cut( prefName.Length() - strlen("directory"), strlen("directory"));
      prefName.Insert("mail.server.", 0);

      nsCOMPtr<nsIPrefBranch> serverBranch;
      aPrefService->GetBranch(prefName.get(), getter_AddRefs(serverBranch));

      if (!serverBranch)
        break; // should we clear out this server pref from aMailServers?

      nsCString serverType;
      serverBranch->GetCharPref("type", getter_Copies(serverType));

      nsCOMPtr<nsILocalFile> sourceMailFolder;
      serverBranch->GetComplexValue("directory", NS_GET_IID(nsILocalFile), getter_AddRefs(sourceMailFolder));

      // now based on type, we need to build a new destination path for the mail folders for this server
      nsCOMPtr<nsIFile> targetMailFolder;
      if (serverType.Equals("imap"))
      {
        mTargetProfile->Clone(getter_AddRefs(targetMailFolder));
        targetMailFolder->Append(IMAP_MAIL_DIR_50_NAME);
      }
      else if (serverType.Equals("none") || serverType.Equals("pop3"))
      {
        // local folders and POP3 servers go under <profile>\Mail
        mTargetProfile->Clone(getter_AddRefs(targetMailFolder));
        targetMailFolder->Append(MAIL_DIR_50_NAME);
      }
      else if (serverType.Equals("nntp"))
      {
        mTargetProfile->Clone(getter_AddRefs(targetMailFolder));
        targetMailFolder->Append(NEWS_DIR_50_NAME);
      }

      if (targetMailFolder)
      {
        // for all of our server types, append the host name to the directory as part of the new location
        nsCString hostName;
        serverBranch->GetCharPref("hostname", getter_Copies(hostName));
        targetMailFolder->Append(NS_ConvertASCIItoUTF16(hostName));

        // we should make sure the host name based directory we are going to migrate
        // the accounts into is unique. This protects against the case where the user
        // has multiple servers with the same host name.
        targetMailFolder->CreateUnique(nsIFile::DIRECTORY_TYPE, 0777);

        rv = RecursiveCopy(sourceMailFolder, targetMailFolder);
        // now we want to make sure the actual directory pref that gets
        // transformed into the new profile's pref.js has the right file
        // location.
        nsCAutoString descriptorString;
        nsCOMPtr<nsILocalFile> localFile = do_QueryInterface(targetMailFolder);
        localFile->GetPersistentDescriptor(descriptorString);
        NS_Free(pref->stringValue);
        pref->stringValue = ToNewCString(descriptorString);
      }
    }
    else if (StringEndsWith(prefName, nsDependentCString(".newsrc.file")))
    {
      // copy the news RC file into \News. this won't work if the user has different newsrc files for each account
      // I don't know what to do in that situation.

      nsCOMPtr<nsIFile> targetNewsRCFile;
      mTargetProfile->Clone(getter_AddRefs(targetNewsRCFile));
      targetNewsRCFile->Append(NEWS_DIR_50_NAME);

      // turn the pref into a nsILocalFile
      nsCOMPtr<nsILocalFile> srcNewsRCFile = do_CreateInstance(NS_LOCAL_FILE_CONTRACTID);
      srcNewsRCFile->SetPersistentDescriptor(nsDependentCString(pref->stringValue));

      // now make the copy
      bool exists;
      srcNewsRCFile->Exists(&exists);
      if (exists)
      {
        nsAutoString leafName;
        srcNewsRCFile->GetLeafName(leafName);
        srcNewsRCFile->CopyTo(targetNewsRCFile,leafName); // will fail if we've already copied a newsrc file here
        targetNewsRCFile->Append(leafName);

        // now write out the new descriptor
        nsCAutoString descriptorString;
        nsCOMPtr<nsILocalFile> localFile = do_QueryInterface(targetNewsRCFile);
        localFile->GetPersistentDescriptor(descriptorString);
        NS_Free(pref->stringValue);
        pref->stringValue = ToNewCString(descriptorString);
      }
    }
  }

  return NS_OK;
}

nsresult
nsSeamonkeyProfileMigrator::CopyPreferences(bool aReplace)
{
  nsresult rv = NS_OK;
  if (!aReplace)
    return rv;

  rv |= TransformPreferences(FILE_NAME_PREFS, FILE_NAME_PREFS);
  rv |= CopyFile(FILE_NAME_USER_PREFS, FILE_NAME_USER_PREFS);

  // Security Stuff
  rv |= CopyFile(FILE_NAME_CERT8DB, FILE_NAME_CERT8DB);
  rv |= CopyFile(FILE_NAME_KEY3DB, FILE_NAME_KEY3DB);
  rv |= CopyFile(FILE_NAME_SECMODDB, FILE_NAME_SECMODDB);

  // User MIME Type overrides
  rv |= CopyFile(FILE_NAME_MIMETYPES, FILE_NAME_MIMETYPES);
  rv |= CopyFile(FILE_NAME_PERSONALDICTIONARY, FILE_NAME_PERSONALDICTIONARY);
  rv |= CopyFile(FILE_NAME_MAILVIEWS, FILE_NAME_MAILVIEWS);
  return rv;
}

void
nsSeamonkeyProfileMigrator::ReadBranch(const char *branchName,
                                       nsIPrefService* aPrefService,
                                       PBStructArray &aPrefs)
{
  // Enumerate the branch
  nsCOMPtr<nsIPrefBranch> branch;
  aPrefService->GetBranch(branchName, getter_AddRefs(branch));

  PRUint32 count;
  char** prefs = nsnull;
  nsresult rv = branch->GetChildList("", &count, &prefs);
  if (NS_FAILED(rv))
    return;

  for (PRUint32 i = 0; i < count; ++i) {
    // Save each pref's value into an array
    char* currPref = prefs[i];
    PRInt32 type;
    branch->GetPrefType(currPref, &type);
    PrefBranchStruct* pref = new PrefBranchStruct;
    pref->prefName = currPref;
    pref->type = type;
    switch (type) {
    case nsIPrefBranch::PREF_STRING:
      rv = branch->GetCharPref(currPref, &pref->stringValue);
      break;
    case nsIPrefBranch::PREF_BOOL:
      rv = branch->GetBoolPref(currPref, &pref->boolValue);
      break;
    case nsIPrefBranch::PREF_INT:
      rv = branch->GetIntPref(currPref, &pref->intValue);
      break;
    default:
      NS_WARNING("Invalid Pref Type in "
                 "nsNetscapeProfileMigratorBase::ReadBranch\n");
      break;
    }

    if (NS_SUCCEEDED(rv))
      aPrefs.AppendElement(pref);
  }
}

void
nsSeamonkeyProfileMigrator::WriteBranch(const char *branchName,
                                        nsIPrefService* aPrefService,
                                        PBStructArray &aPrefs)
{
  nsresult rv;

  // Enumerate the branch
  nsCOMPtr<nsIPrefBranch> branch;
  aPrefService->GetBranch(branchName, getter_AddRefs(branch));

  PRUint32 count = aPrefs.Length();
  for (PRUint32 i = 0; i < count; ++i) {
    PrefBranchStruct* pref = aPrefs.ElementAt(i);
    switch (pref->type) {
    case nsIPrefBranch::PREF_STRING:
      rv = branch->SetCharPref(pref->prefName, pref->stringValue);
      NS_Free(pref->stringValue);
      pref->stringValue = nsnull;
      break;
    case nsIPrefBranch::PREF_BOOL:
      rv = branch->SetBoolPref(pref->prefName, pref->boolValue);
      break;
    case nsIPrefBranch::PREF_INT:
      rv = branch->SetIntPref(pref->prefName, pref->intValue);
      break;
    default:
      NS_WARNING("Invalid Pref Type in "
                 "nsNetscapeProfileMigratorBase::WriteBranch\n");
      break;
    }
    NS_Free(pref->prefName);
    pref->prefName = nsnull;
    delete pref;
    pref = nsnull;
  }
  aPrefs.Clear();
}

nsresult nsSeamonkeyProfileMigrator::DummyCopyRoutine(bool aReplace)
{
  // place holder function only to fake the UI out into showing some migration process.
  return NS_OK;
}

nsresult
nsSeamonkeyProfileMigrator::CopyJunkTraining(bool aReplace)
{
  return aReplace ? CopyFile(FILE_NAME_JUNKTRAINING, FILE_NAME_JUNKTRAINING) : NS_OK;
}

nsresult
nsSeamonkeyProfileMigrator::CopyPasswords(bool aReplace)
{
  nsresult rv;

  nsCString signonsFileName;
  GetSignonFileName(aReplace, getter_Copies(signonsFileName));

  if (signonsFileName.IsEmpty())
    return NS_ERROR_FILE_NOT_FOUND;

  nsAutoString fileName;
  CopyASCIItoUTF16(signonsFileName, fileName);
  if (aReplace)
    rv = CopyFile(fileName, fileName);
  else {
    // don't do anything right now
  }
  return rv;
}
