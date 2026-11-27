--------------------------- MODULE Migration ---------------------------
(***************************************************************************)
(* Converting a vault for the add-on while another device keeps syncing   *)
(* (src/services/migration-service.ts, the migration.lock gate in          *)
(* src/sync-manager/sync-manager.ts).                                      *)
(*                                                                         *)
(* Device A converts: lock -> upload every file to the temp folder ->      *)
(* catch-up scan of the old folder -> swap (old folder becomes the backup, *)
(* the temp folder becomes the vault, vault-lock appears) -> delete the   *)
(* backup. Device B edits, deletes and syncs throughout. A sync cycle of B *)
(* checks the locks once at its start and may push any time until it      *)
(* ends; its pushes go to the old folder (by file id / cached root id),    *)
(* also after that folder was renamed to the backup. After the swap B     *)
(* re-syncs with the converted vault.                                      *)
(*                                                                         *)
(* File contents are version numbers; every user edit makes a new one.    *)
(* `heads` holds the versions no user has knowingly replaced: each must   *)
(* stay somewhere (a device, the vault, a live folder, a conflict copy).  *)
(*                                                                         *)
(* Flags select the code: Gate (B honours migration.lock, PR #43),        *)
(* CatchUp (A's scan before the swap, PR #43), CatchUpDeletes (the scan    *)
(* also carries over B's deletions), DeferCleanup (the backup is deleted  *)
(* only after a later re-scan, once B's cycles that started before the    *)
(* swap have ended), FollowFolder (a device whose index belongs to the old *)
(* folder notices the swap at its next cycle and re-bases the index onto   *)
(* the new folder; 0.19.3).                                                *)
(*                                                                         *)
(* A cloud folder is held by id, and so is every file of the index. The    *)
(* swap gives the vault a NEW folder with new file ids. Until 0.19.3 the   *)
(* model let B "re-sync with the converted vault" by comparing versions    *)
(* per path, as if B looked at the new folder with an index that fits it.  *)
(* The code did neither: a running B kept the old folder (no vault-lock    *)
(* in it, migration.lock for ever: every cycle skipped), and after a       *)
(* restart its index still named the old folder's files, so each file of   *)
(* the vault looked like an unrelated note of the same name: the vault's   *)
(* copy was renamed aside and B's plaintext file moved into the vault.     *)
(* bFolder, bBlind and plainIn model that.                                 *)
(*                                                                         *)
(* "B" stands for every device of the set Others: each has its own files,  *)
(* base, cycle state and folder, so the devices follow the swap at         *)
(* different times and also see each other's changes (BPull).              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Files, Others, Absent, MaxVer, Gate, CatchUp, CatchUpDeletes, DeferCleanup, FollowFolder, UseConvBase

VARIABLES
    phase,      \* A: "idle" "locked" "uploaded" "caughtup" "swapped" "done"
    lockFile,   \* migration.lock present
    vaultLock,  \* vault-lock present (after the swap)
    old,        \* the plaintext vault folder (the backup after the swap)
    oldAtScan,  \* what the catch-up scan saw in it
    oldExists,
    temp,       \* the converted vault
    conflicts,  \* versions kept as conflict copies
    aLocal, aSynced, converted, uploaded, aEdited,
    bLocal, bBase, bMode, bStartedBeforeSwap,
    bDeleted,   \* versions a device deleted and synced
    heads, nextVer,
    bFolder,    \* the folder B holds by id: "old" or "new"
    bBlind,     \* a cycle of B began after the swap without noticing it
    plainIn,    \* files of the vault replaced by B's plaintext file of the old folder
    convBase    \* what the converted vault held at the swap (conversion-base.json)

\* B's view of the folder swap
bView == <<bFolder, bBlind, plainIn>>

vars == <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts,
          aLocal, aSynced, converted, uploaded, aEdited,
          bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer, bView, convBase>>

Ver == 0..MaxVer
Val == Ver \cup {Absent}
Range(m) == {m[f] : f \in Files} \ {Absent}

\* every file starts as version i (distinct per file), synced everywhere
InitVer == CHOOSE v \in [Files -> Ver] : \A f, g \in Files : f # g => v[f] # v[g]

Init ==
    /\ phase = "idle" /\ lockFile = FALSE /\ vaultLock = FALSE
    /\ old = InitVer /\ oldAtScan = InitVer /\ oldExists = TRUE
    /\ temp = [f \in Files |-> Absent]
    /\ conflicts = {}
    /\ aLocal = InitVer /\ aSynced = InitVer
    /\ converted = [f \in Files |-> Absent] /\ uploaded = {} /\ aEdited = {}
    /\ bLocal = [d \in Others |-> InitVer] /\ bBase = [d \in Others |-> InitVer]
    /\ bMode = [d \in Others |-> "idle"] /\ bStartedBeforeSwap = [d \in Others |-> FALSE] /\ bDeleted = {}
    /\ heads = Range(InitVer)
    /\ nextVer = Cardinality(Files)
    /\ bFolder = [d \in Others |-> "old"] /\ bBlind = FALSE /\ plainIn = {}
    /\ convBase = [f \in Files |-> Absent]

NewVer == nextVer < MaxVer

-----------------------------------------------------------------------------
(* Device A *)

AEdit(f) ==
    /\ NewVer /\ phase \in {"locked", "uploaded"}
    /\ aLocal' = [aLocal EXCEPT ![f] = nextVer]
    /\ heads' = (heads \ {aLocal[f]}) \cup {nextVer}
    /\ nextVer' = nextVer + 1
    /\ aEdited' = aEdited \cup {f}
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts,
                   aSynced, converted, uploaded, bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted>>

StartMigration ==
    /\ phase = "idle"
    /\ phase' = "locked" /\ lockFile' = TRUE
    /\ UNCHANGED <<vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced, converted,
                   uploaded, aEdited, bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

Upload(f) ==
    /\ phase = "locked" /\ f \notin uploaded
    /\ uploaded' = uploaded \cup {f}
    /\ converted' = [converted EXCEPT ![f] = aLocal[f]]
    /\ temp' = [temp EXCEPT ![f] = aLocal[f]]
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, conflicts, aLocal, aSynced,
                   aEdited, bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

UploadDone ==
    /\ phase = "locked" /\ uploaded = Files
    /\ phase' = "uploaded"
    /\ UNCHANGED <<lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced, converted,
                   uploaded, aEdited, bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* What the catch-up does with one file of the folder `src`, against the
\* baseline `base` (what A last synced). Returns [local, temp, conflict].
\* Neither this device nor the vault moved away from the baseline (the
\* vault can move on between the swap and the deferred scan: B re-syncs)
Untouched(f, base) ==
    IF aLocal[f] = Absent THEN temp[f] = Absent
    ELSE temp[f] = base[f] /\ aLocal[f] = base[f]

CatchFile(f, src, base) ==
    LET r == src[f] IN
    IF r = base[f] THEN [l |-> aLocal[f], t |-> temp[f], c |-> {}]
    ELSE IF r = Absent
        THEN IF CatchUpDeletes /\ base[f] # Absent /\ Untouched(f, base)
                THEN [l |-> Absent, t |-> Absent, c |-> {}]
                ELSE [l |-> aLocal[f], t |-> temp[f], c |-> {}]
    ELSE IF r = temp[f] \/ r = aLocal[f] THEN [l |-> aLocal[f], t |-> temp[f], c |-> {}]
    ELSE IF Untouched(f, base) THEN [l |-> r, t |-> r, c |-> {}]
    ELSE [l |-> aLocal[f], t |-> temp[f], c |-> {r}]

DoCatchUp(src, base) ==
    LET res == [f \in Files |-> CatchFile(f, src, base)] IN
    /\ aLocal' = [f \in Files |-> res[f].l]
    /\ temp' = [f \in Files |-> res[f].t]
    /\ converted' = [f \in Files |-> res[f].t]
    /\ conflicts' = conflicts \cup UNION {res[f].c : f \in Files}

CatchUpStep ==
    /\ phase = "uploaded"
    /\ phase' = "caughtup"
    /\ IF CatchUp THEN DoCatchUp(old, aSynced)
       ELSE UNCHANGED <<aLocal, temp, converted, conflicts>>
    /\ oldAtScan' = old
    /\ UNCHANGED <<lockFile, vaultLock, old, oldExists, aSynced, uploaded, aEdited,
                   bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* After the swap A's index is the converted vault
Swap ==
    /\ phase = "caughtup"
    /\ phase' = "swapped" /\ vaultLock' = TRUE
    /\ aSynced' = converted
    /\ bStartedBeforeSwap' = [d \in Others |-> bMode[d] = "pushing"]
    /\ UNCHANGED <<lockFile, old, oldAtScan, oldExists, temp, conflicts, aLocal, converted, uploaded,
                   aEdited, bLocal, bBase, bMode, bDeleted, heads, nextVer>>

\* PR #43: the backup is deleted right after the swap
DeleteBackupNow ==
    /\ ~DeferCleanup /\ phase = "swapped"
    /\ phase' = "done" /\ oldExists' = FALSE /\ lockFile' = FALSE
    /\ UNCHANGED <<vaultLock, old, oldAtScan, temp, conflicts, aLocal, aSynced, converted, uploaded,
                   aEdited, bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* Deferred: once no cycle of B that began before the swap is still running
\* (the grace period exceeds a sync cycle), scan the backup again for what
\* changed since the first scan, then delete it
DeferredCleanup ==
    /\ DeferCleanup /\ phase = "swapped"
    /\ \A d \in Others : ~(bStartedBeforeSwap[d] /\ bMode[d] = "pushing")
    /\ phase' = "done" /\ oldExists' = FALSE /\ lockFile' = FALSE
    /\ DoCatchUp(old, oldAtScan)
    /\ UNCHANGED <<vaultLock, old, oldAtScan, aSynced, uploaded, aEdited,
                   bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

-----------------------------------------------------------------------------
(* The other devices *)

\* (an edit of a deleted note creates it again: no longer "deleted")
BEdit(d, f) ==
    /\ NewVer
    /\ bLocal' = [bLocal EXCEPT ![d][f] = nextVer]
    /\ heads' = (heads \ {bLocal[d][f]}) \cup {nextVer}
    /\ nextVer' = nextVer + 1
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bBase, bMode, bStartedBeforeSwap, bDeleted>>

\* A deletion of a version another device has replaced meanwhile is not the
\* user's word on that newer version: only the deleted version leaves `heads`
BDelete(d, f) ==
    /\ bLocal[d][f] # Absent
    /\ bLocal' = [bLocal EXCEPT ![d][f] = Absent]
    /\ heads' = heads \ {bLocal[d][f]}
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bBase, bMode, bStartedBeforeSwap, bDeleted, nextVer>>

\* A cycle checks the locks once, at its start, in the folder it holds.
\* The vault-lock is in the new folder only. FollowFolder: the swap is seen
\* (migration.lock in the old folder, or the folder's change in the change
\* feed) and the vault folder is looked up again. A folder that is gone is
\* looked up again by every version.
BStartCycle(d) ==
    LET folder == IF (FollowFolder /\ vaultLock) \/ ~oldExists THEN "new" ELSE bFolder[d]
        sees == vaultLock /\ folder = "new"
    IN
    /\ bMode[d] = "idle"
    /\ bFolder' = [bFolder EXCEPT ![d] = folder]
    /\ bMode' = [bMode EXCEPT ![d] = IF sees THEN "resync"
                                      ELSE IF Gate /\ lockFile THEN "idle" ELSE "pushing"]
    /\ bBlind' = (bBlind \/ (vaultLock /\ ~sees))
    /\ (Gate /\ lockFile /\ ~vaultLock) => FALSE   \* a gated cycle does nothing
    /\ UNCHANGED <<plainIn, convBase>>
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bBase, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* Push a local change into the old folder (by id), if the cloud copy is
\* still the one the device based it on (otherwise it merges first; not modelled)
BPush(d, f) ==
    /\ bMode[d] = "pushing" /\ oldExists
    /\ bLocal[d][f] # bBase[d][f] /\ old[f] = bBase[d][f]
    /\ old' = [old EXCEPT ![f] = bLocal[d][f]]
    /\ bBase' = [bBase EXCEPT ![d][f] = bLocal[d][f]]
    /\ bDeleted' = IF bLocal[d][f] = Absent THEN bDeleted \cup {old[f]} ELSE bDeleted
    /\ UNCHANGED <<phase, lockFile, vaultLock, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bMode, bStartedBeforeSwap, heads, nextVer>>

\* Take another device's change from the old folder (untouched here)
BPull(d, f) ==
    /\ bMode[d] = "pushing" /\ oldExists
    /\ bLocal[d][f] = bBase[d][f] /\ old[f] # bBase[d][f]
    /\ bLocal' = [bLocal EXCEPT ![d][f] = old[f]]
    /\ bBase' = [bBase EXCEPT ![d][f] = old[f]]
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

BEndCycle(d) ==
    /\ bMode[d] \in {"pushing", "resync"}
    /\ bMode' = [bMode EXCEPT ![d] = "idle"]
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bBase, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* After the conversion a device syncs one file with the converted vault: an
\* unchanged local file takes the cloud's version; a local change goes up,
\* or, when the cloud changed too, the cloud's version is taken and the
\* device's own is kept as a conflict copy
BResync(d, f) ==
    /\ bMode[d] = "resync"
    \* The index fits the vault folder: re-based (FollowFolder), or its old files
    \* are gone and every entry counts as new
    /\ FollowFolder \/ ~oldExists
    \* A file the vault does not hold is a deletion only when the vault held this
    \* very version at the swap and the device has not touched it since
    /\ \/ /\ bLocal[d][f] = bBase[d][f] /\ temp[f] # bBase[d][f]
          /\ temp[f] # Absent \/ (UseConvBase /\ convBase[f] = bBase[d][f])
          /\ bLocal' = [bLocal EXCEPT ![d][f] = temp[f]]
          /\ bBase' = [bBase EXCEPT ![d][f] = temp[f]]
          /\ UNCHANGED <<temp, conflicts, bDeleted>>
       \/ /\ bLocal[d][f] # bBase[d][f] /\ temp[f] = bBase[d][f]
          /\ temp' = [temp EXCEPT ![f] = bLocal[d][f]]
          /\ bBase' = [bBase EXCEPT ![d][f] = bLocal[d][f]]
          /\ bDeleted' = IF bLocal[d][f] = Absent THEN bDeleted \cup {temp[f]} ELSE bDeleted
          /\ UNCHANGED <<bLocal, conflicts>>
       \* ... otherwise it never reached the vault (pushed into the old folder too
       \* late): forgotten, and uploaded as a new file
       \/ /\ temp[f] = Absent /\ bBase[d][f] # Absent /\ bLocal[d][f] # Absent
          /\ ~(UseConvBase /\ bLocal[d][f] = bBase[d][f] /\ convBase[f] = bBase[d][f])
          /\ temp' = [temp EXCEPT ![f] = bLocal[d][f]]
          /\ bBase' = [bBase EXCEPT ![d][f] = bLocal[d][f]]
          /\ UNCHANGED <<bLocal, conflicts, bDeleted>>
       \/ /\ bLocal[d][f] # bBase[d][f] /\ temp[f] # bBase[d][f] /\ temp[f] # bLocal[d][f]
          /\ temp[f] # Absent
          /\ conflicts' = IF bLocal[d][f] # Absent THEN conflicts \cup {bLocal[d][f]} ELSE conflicts
          /\ bLocal' = [bLocal EXCEPT ![d][f] = temp[f]]
          /\ bBase' = [bBase EXCEPT ![d][f] = temp[f]]
          /\ UNCHANGED <<temp, bDeleted>>
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, aLocal, aSynced, converted, uploaded,
                   aEdited, bMode, bStartedBeforeSwap, heads, nextVer>>

-----------------------------------------------------------------------------

\* The app is started again: the vault folder is looked up by name
BRestart(d) ==
    /\ bMode[d] = "idle" /\ bFolder[d] = "old" /\ vaultLock
    /\ bFolder' = [bFolder EXCEPT ![d] = "new"]
    /\ UNCHANGED <<bBlind, plainIn, convBase>>
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* Without FollowFolder: the device's index names the file of the OLD folder.
\* The vault's file of that name has another id, so it is taken for an
\* unrelated note of the same name: it is renamed aside ("name (2)", kept),
\* and the plaintext file is moved from the old folder into the vault.
BResyncStale(d, f) ==
    /\ ~FollowFolder /\ bMode[d] = "resync" /\ oldExists
    /\ old[f] # Absent /\ temp[f] # Absent /\ f \notin plainIn
    /\ conflicts' = conflicts \cup {temp[f]}
    /\ temp' = [temp EXCEPT ![f] = old[f]]
    /\ bBase' = [bBase EXCEPT ![d][f] = old[f]]
    /\ plainIn' = plainIn \cup {f}
    /\ UNCHANGED <<bFolder, bBlind, convBase>>
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, aLocal, aSynced, converted, uploaded,
                   aEdited, bLocal, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

-----------------------------------------------------------------------------

\* The actions that do not touch B's view of the swap
Keep(A) == A /\ UNCHANGED bView /\ UNCHANGED convBase

AConverts ==
    \/ Keep(StartMigration \/ UploadDone \/ CatchUpStep \/ DeleteBackupNow \/ DeferredCleanup)
    \/ (Swap /\ convBase' = converted /\ UNCHANGED bView)

Next ==
    \/ AConverts
    \/ \E f \in Files : Keep(AEdit(f) \/ Upload(f))
    \/ \E d \in Others, f \in Files :
          Keep(BEdit(d, f) \/ BDelete(d, f) \/ BPush(d, f) \/ BPull(d, f) \/ BResync(d, f)) \/ BResyncStale(d, f)
    \/ \E d \in Others : Keep(BEndCycle(d)) \/ BStartCycle(d) \/ BRestart(d)

Spec == Init /\ [][Next]_vars
    /\ WF_vars(AConverts)
    /\ WF_vars(\E f \in Files : Keep(Upload(f)))
    /\ \A d \in Others : WF_vars(Keep(BEndCycle(d)))

-----------------------------------------------------------------------------
(* Safety *)

Kept == Range(aLocal) \cup UNION {Range(bLocal[d]) : d \in Others} \cup Range(temp) \cup conflicts
        \cup (IF oldExists THEN Range(old) ELSE {})

\* No version a user still stands behind is lost
NoLostEdit == heads \subseteq Kept

\* A version a device deleted (and synced) is not a file of the vault again
\* once the conversion is over. (A newer version another device made of the
\* note meanwhile is an edit and stays; so does a version A has edited and
\* not pushed yet: its next push replaces it.)
Resurrected(f) == temp[f] \in bDeleted /\ aLocal[f] = temp[f]

\* ... for every version the converted vault held at the swap
NoResurrection ==
    phase = "done" => \A f \in Files : ~(Resurrected(f) /\ temp[f] = convBase[f])

\* ... for every version. KNOWN OPEN DEFECT: a version pushed into the old
\* folder after the catch-up scan, brought to the vault by its device and then
\* deleted there before the old folder is cleaned up, is taken from the old
\* folder once more (the cleanup cannot tell it from one that never arrived).
NoLateResurrection ==
    phase = "done" => \A f \in Files : ~Resurrected(f)

\* A cycle that begins after the swap notices the conversion (and stops for
\* the password) instead of skipping or pushing into the old folder
SeesConversion == ~bBlind

\* Nothing but converted files in the converted vault
VaultEncrypted == plainIn = {}

\* Liveness: the conversion always finishes
ConversionFinishes == phase = "locked" ~> phase = "done"
=============================================================================
