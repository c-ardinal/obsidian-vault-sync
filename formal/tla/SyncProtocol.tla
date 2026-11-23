--------------------------- MODULE SyncProtocol ---------------------------
(***************************************************************************)
(* Two devices syncing one note through Google Drive, which cannot replace *)
(* a file only if it is unchanged (no compare-and-set).                   *)
(*                                                                         *)
(*  - Push (src/sync-manager/sync-push.ts): when the cloud still holds the *)
(*    version the local edit is based on, upload; otherwise 3-way merge    *)
(*    first. The check and the upload are separate steps, so another       *)
(*    device can upload in between: the later upload silently replaces    *)
(*    the earlier one.                                                     *)
(*  - Overwrite check (src/sync-manager/overwrite-recovery.ts): right      *)
(*    after an upload, the revision before ours must be the version our    *)
(*    edit was based on. If not, we replaced another device's version: we  *)
(*    keep it and merge it in once our copy caught up with the cloud.      *)
(*  - Merge lock (communication.json, src/sync-manager/state.ts): read,    *)
(*    write our entry, read again to verify. Also without compare-and-set. *)
(*                                                                         *)
(* A version is the set of edits it contains; a 3-way merge of text keeps  *)
(* the edits of both sides (union). Deletions are not modelled here (the  *)
(* multi-device simulation covers them).                                   *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Devices, Edits, MaxRevs, Check, UseLock

VARIABLES
    revs,       \* revision history of the note: [c: edits, by: device or "init"]
    made,       \* edits the users made so far
    local,      \* note content on each device
    base,       \* revision each device last synced with
    pc,         \* "idle" | "checked" (decided to upload) | "uploaded" (check owed)
    planC,      \* content being uploaded
    planBase,   \* revision the upload is based on
    mine,       \* revision of the device's last upload
    repair,     \* overwritten revisions this device still has to merge in
    lockFile,   \* merge lock holder written in communication.json, or "none"
    lockPc      \* "free" | "read" (saw it free) | "wrote" | "held"

vars == <<revs, made, local, base, pc, planC, planBase, mine, repair, lockFile, lockPc>>

LastIdx == Len(revs)
Last == revs[LastIdx]
Changed(d) == local[d] # revs[base[d]].c
LockOK(d) == ~UseLock \/ lockPc[d] = "held"

Init ==
    /\ revs = <<[c |-> {}, by |-> "init"]>>
    /\ made = {}
    /\ local = [d \in Devices |-> {}]
    /\ base = [d \in Devices |-> 1]
    /\ pc = [d \in Devices |-> "idle"]
    /\ planC = [d \in Devices |-> {}]
    /\ planBase = [d \in Devices |-> 0]
    /\ mine = [d \in Devices |-> 0]
    /\ repair = [d \in Devices |-> {}]
    /\ lockFile = "none"
    /\ lockPc = [d \in Devices |-> "free"]

Edit(d, e) ==
    /\ e \notin made
    /\ made' = made \cup {e}
    /\ local' = [local EXCEPT ![d] = @ \cup {e}]
    /\ UNCHANGED <<revs, base, pc, planC, planBase, mine, repair, lockFile, lockPc>>

\* No local change, the cloud has a newer version: take it
Pull(d) ==
    /\ pc[d] = "idle" /\ ~Changed(d) /\ base[d] # LastIdx
    /\ local' = [local EXCEPT ![d] = Last.c]
    /\ base' = [base EXCEPT ![d] = LastIdx]
    /\ UNCHANGED <<revs, made, pc, planC, planBase, mine, repair, lockFile, lockPc>>

\* Changed here and in the cloud: 3-way merge (under the merge lock)
Merge(d) ==
    /\ pc[d] = "idle" /\ Changed(d) /\ base[d] # LastIdx /\ LockOK(d)
    /\ local' = [local EXCEPT ![d] = @ \cup Last.c]
    /\ base' = [base EXCEPT ![d] = LastIdx]
    /\ UNCHANGED <<revs, made, pc, planC, planBase, mine, repair, lockFile, lockPc>>

\* The cloud still holds our base: decide to upload what we have now
StartPush(d) ==
    /\ pc[d] = "idle" /\ Changed(d) /\ base[d] = LastIdx
    /\ pc' = [pc EXCEPT ![d] = "checked"]
    /\ planC' = [planC EXCEPT ![d] = local[d]]
    /\ planBase' = [planBase EXCEPT ![d] = base[d]]
    /\ UNCHANGED <<revs, made, local, base, mine, repair, lockFile, lockPc>>

\* The upload lands on whatever the cloud holds by now
Upload(d) ==
    /\ pc[d] = "checked" /\ Len(revs) < MaxRevs
    /\ revs' = Append(revs, [c |-> planC[d], by |-> d])
    /\ base' = [base EXCEPT ![d] = Len(revs) + 1]
    /\ mine' = [mine EXCEPT ![d] = Len(revs) + 1]
    /\ pc' = [pc EXCEPT ![d] = "uploaded"]
    /\ UNCHANGED <<made, local, planC, planBase, repair, lockFile, lockPc>>

\* Overwrite check: the revision before ours should be our base
PostCheck(d) ==
    /\ pc[d] = "uploaded"
    /\ LET prev == mine[d] - 1
       IN repair' = [repair EXCEPT ![d] =
            IF Check /\ prev # planBase[d] /\ revs[prev].by # d THEN @ \cup {prev} ELSE @]
    /\ pc' = [pc EXCEPT ![d] = "idle"]
    /\ UNCHANGED <<revs, made, local, base, planC, planBase, mine, lockFile, lockPc>>

\* Merge an overwritten version in, once caught up with the cloud (under the lock)
Repair(d, r) ==
    /\ r \in repair[d] /\ pc[d] = "idle" /\ base[d] = LastIdx /\ LockOK(d)
    /\ local' = [local EXCEPT ![d] = @ \cup revs[r].c]
    /\ repair' = [repair EXCEPT ![d] = @ \ {r}]
    /\ UNCHANGED <<revs, made, base, pc, planC, planBase, mine, lockFile, lockPc>>

\* Merge lock: read, write, verify, release
LockRead(d) ==
    /\ UseLock /\ lockPc[d] = "free" /\ lockFile \in {"none", d}
    /\ lockPc' = [lockPc EXCEPT ![d] = "read"]
    /\ UNCHANGED <<revs, made, local, base, pc, planC, planBase, mine, repair, lockFile>>
LockWrite(d) ==
    /\ lockPc[d] = "read"
    /\ lockFile' = d
    /\ lockPc' = [lockPc EXCEPT ![d] = "wrote"]
    /\ UNCHANGED <<revs, made, local, base, pc, planC, planBase, mine, repair>>
LockVerify(d) ==
    /\ lockPc[d] = "wrote"
    /\ lockPc' = [lockPc EXCEPT ![d] = IF lockFile = d THEN "held" ELSE "free"]
    /\ UNCHANGED <<revs, made, local, base, pc, planC, planBase, mine, repair, lockFile>>
LockRelease(d) ==
    /\ lockPc[d] = "held" /\ pc[d] = "idle"
    /\ lockFile' = IF lockFile = d THEN "none" ELSE lockFile
    /\ lockPc' = [lockPc EXCEPT ![d] = "free"]
    /\ UNCHANGED <<revs, made, local, base, pc, planC, planBase, mine, repair>>

Step(d) ==
    \/ Pull(d) \/ Merge(d) \/ StartPush(d) \/ Upload(d) \/ PostCheck(d)
    \/ \E r \in repair[d] : Repair(d, r)
    \/ LockRead(d) \/ LockWrite(d) \/ LockVerify(d) \/ LockRelease(d)

Next == \/ \E d \in Devices, e \in Edits : Edit(d, e)
        \/ \E d \in Devices : Step(d)

Spec == Init /\ [][Next]_vars /\ \A d \in Devices : WF_vars(Step(d))

-----------------------------------------------------------------------------
(* Safety *)

\* Every edit made is somewhere a device will still bring into the note: the
\* cloud's current version, a device's copy, an upload in flight or whose
\* check is owed, or an overwritten version a device still has to merge in
NoLostEdit ==
    \A e \in made :
        \/ e \in Last.c
        \/ \E d \in Devices :
            \/ e \in local[d]
            \/ pc[d] \in {"checked", "uploaded"} /\ e \in planC[d]
            \/ pc[d] = "uploaded" /\ e \in revs[mine[d] - 1].c
            \/ \E r \in repair[d] : e \in revs[r].c

\* Once nothing is left to do, the cloud holds every edit
Quiet == /\ made = Edits
         /\ \A d \in Devices : pc[d] = "idle" /\ repair[d] = {} /\ ~Changed(d) /\ base[d] = LastIdx
QuietMeansConverged == Quiet => Last.c = Edits

\* At most one device believes it holds the merge lock
LockExclusive == Cardinality({d \in Devices : lockPc[d] = "held"}) <= 1

(* Liveness: after the last edit, the cloud and every device end up with   *)
(* every edit made                                                         *)
Converges == <>[](Last.c = made /\ \A d \in Devices : local[d] = made)
=============================================================================
