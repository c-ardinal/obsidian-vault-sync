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
(* swap have ended).                                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Files, Absent, MaxVer, Gate, CatchUp, CatchUpDeletes, DeferCleanup

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
    bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted,
    heads, nextVer

vars == <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts,
          aLocal, aSynced, converted, uploaded, aEdited,
          bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

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
    /\ bLocal = InitVer /\ bBase = InitVer
    /\ bMode = "idle" /\ bStartedBeforeSwap = FALSE /\ bDeleted = {}
    /\ heads = Range(InitVer)
    /\ nextVer = Cardinality(Files)

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
    /\ bStartedBeforeSwap' = (bMode = "pushing")
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
    /\ ~(bStartedBeforeSwap /\ bMode = "pushing")
    /\ phase' = "done" /\ oldExists' = FALSE /\ lockFile' = FALSE
    /\ DoCatchUp(old, oldAtScan)
    /\ UNCHANGED <<vaultLock, old, oldAtScan, aSynced, uploaded, aEdited,
                   bLocal, bBase, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

-----------------------------------------------------------------------------
(* Device B *)

\* (an edit of a deleted note creates it again: no longer "deleted by B")
BEdit(f) ==
    /\ NewVer
    /\ bLocal' = [bLocal EXCEPT ![f] = nextVer]
    /\ heads' = (heads \ {bLocal[f]}) \cup {nextVer}
    /\ nextVer' = nextVer + 1
    /\ bDeleted' = bDeleted \ {f}
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bBase, bMode, bStartedBeforeSwap>>

BDelete(f) ==
    /\ bLocal[f] # Absent
    /\ bLocal' = [bLocal EXCEPT ![f] = Absent]
    /\ heads' = heads \ {bLocal[f]}
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bBase, bMode, bStartedBeforeSwap, bDeleted, nextVer>>

\* A cycle checks the locks once, at its start
BStartCycle ==
    /\ bMode = "idle"
    /\ bMode' = IF vaultLock THEN "resync"
                ELSE IF Gate /\ lockFile THEN "idle" ELSE "pushing"
    /\ (Gate /\ lockFile /\ ~vaultLock) => FALSE   \* a gated cycle does nothing
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bBase, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* Push a local change into the old folder (by id), if the cloud copy is
\* still the one B based it on (otherwise B would merge first; not modelled)
BPush(f) ==
    /\ bMode = "pushing" /\ oldExists
    /\ bLocal[f] # bBase[f] /\ old[f] = bBase[f]
    /\ old' = [old EXCEPT ![f] = bLocal[f]]
    /\ bBase' = [bBase EXCEPT ![f] = bLocal[f]]
    /\ bDeleted' = IF bLocal[f] = Absent THEN bDeleted \cup {f} ELSE bDeleted \ {f}
    /\ UNCHANGED <<phase, lockFile, vaultLock, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bMode, bStartedBeforeSwap, heads, nextVer>>

BEndCycle ==
    /\ bMode = "pushing"
    /\ bMode' = "idle"
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, temp, conflicts, aLocal, aSynced,
                   converted, uploaded, aEdited, bLocal, bBase, bStartedBeforeSwap, bDeleted, heads, nextVer>>

\* After the conversion B syncs one file with the converted vault: an
\* unchanged local file takes the cloud's version; a local change goes up,
\* or, when the cloud changed too, the cloud's version is taken and B's is
\* kept as a conflict copy
BResync(f) ==
    /\ bMode = "resync"
    /\ \/ /\ bLocal[f] = bBase[f] /\ temp[f] # bBase[f]
          /\ bLocal' = [bLocal EXCEPT ![f] = temp[f]]
          /\ bBase' = [bBase EXCEPT ![f] = temp[f]]
          /\ UNCHANGED <<temp, conflicts>>
       \/ /\ bLocal[f] # bBase[f] /\ temp[f] = bBase[f]
          /\ temp' = [temp EXCEPT ![f] = bLocal[f]]
          /\ bBase' = [bBase EXCEPT ![f] = bLocal[f]]
          /\ UNCHANGED <<bLocal, conflicts>>
       \/ /\ bLocal[f] # bBase[f] /\ temp[f] # bBase[f] /\ temp[f] # bLocal[f]
          /\ conflicts' = IF bLocal[f] # Absent THEN conflicts \cup {bLocal[f]} ELSE conflicts
          /\ bLocal' = [bLocal EXCEPT ![f] = temp[f]]
          /\ bBase' = [bBase EXCEPT ![f] = temp[f]]
          /\ UNCHANGED temp
    /\ UNCHANGED <<phase, lockFile, vaultLock, old, oldAtScan, oldExists, aLocal, aSynced, converted, uploaded,
                   aEdited, bMode, bStartedBeforeSwap, bDeleted, heads, nextVer>>

-----------------------------------------------------------------------------

Next ==
    \/ StartMigration \/ UploadDone \/ CatchUpStep \/ Swap \/ DeleteBackupNow \/ DeferredCleanup
    \/ \E f \in Files : AEdit(f) \/ Upload(f) \/ BEdit(f) \/ BDelete(f) \/ BPush(f) \/ BResync(f)
    \/ BStartCycle \/ BEndCycle

Spec == Init /\ [][Next]_vars
    /\ WF_vars(StartMigration \/ UploadDone \/ CatchUpStep \/ Swap \/ DeleteBackupNow \/ DeferredCleanup)
    /\ WF_vars(\E f \in Files : Upload(f))
    /\ WF_vars(BEndCycle)

-----------------------------------------------------------------------------
(* Safety *)

Kept == Range(aLocal) \cup Range(bLocal) \cup Range(temp) \cup conflicts
        \cup (IF oldExists THEN Range(old) ELSE {})

\* No version a user still stands behind is lost
NoLostEdit == heads \subseteq Kept

\* A note B deleted (and synced) does not come back unless A edited it
NoResurrection ==
    phase = "done" => \A f \in bDeleted : f \in aEdited \/ temp[f] = Absent

\* Liveness: the conversion always finishes
ConversionFinishes == phase = "locked" ~> phase = "done"
=============================================================================
