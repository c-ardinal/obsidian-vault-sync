---------------------------- MODULE CloudRetry ----------------------------
(***************************************************************************)
(* Retrying a create request (new file or folder) of the Google Drive     *)
(* adapter (src/cloud-adapters/google-drive/index.ts uploadFile,          *)
(* path-resolver.ts createFolder, http-client.ts fetchWithAuth).           *)
(*                                                                         *)
(* A POST that creates an item is not idempotent. Drive can carry it out  *)
(* and still answer 5xx, or the answer can be lost on the way back (the   *)
(* client sees a network error). Meanwhile another device may create an   *)
(* item with the same name in the same folder (Drive allows that).        *)
(*                                                                         *)
(* Mode = "blind":  the request is sent again (code before the fix).      *)
(* Mode = "name":   before sending again, look for an item of that name.  *)
(* Mode = "marker": each create carries a random marker (appProperties);  *)
(*                  before sending again, look for the marker.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxAttempts, Mode

VARIABLES
    server,     \* items named p in the folder: [by: "me" | "other", n: attempt]
    phase,      \* "idle" | "sent" | "lookup" | "done" | "failed"
    attempts,
    result,     \* the item the client records as its upload, or "none"
    otherDone

vars == <<server, phase, attempts, result, otherDone>>

Init ==
    /\ server = {} /\ phase = "idle" /\ attempts = 0
    /\ result = "none" /\ otherDone = FALSE

Send ==
    /\ phase = "idle"
    /\ IF attempts < MaxAttempts
        THEN phase' = "sent" /\ attempts' = attempts + 1
        ELSE phase' = "failed" /\ UNCHANGED attempts
    /\ UNCHANGED <<server, result, otherDone>>

Ambiguous == IF Mode = "blind" THEN "idle" ELSE "lookup"

\* Drive handles the request and answers (or the answer is lost)
Outcome ==
    /\ phase = "sent"
    /\ \/ \* carried out, answer arrives
          /\ server' = server \cup {[by |-> "me", n |-> attempts]}
          /\ phase' = "done" /\ result' = [by |-> "me", n |-> attempts]
       \/ \* carried out, but 5xx or the answer is lost
          /\ server' = server \cup {[by |-> "me", n |-> attempts]}
          /\ phase' = Ambiguous /\ UNCHANGED result
       \/ \* not carried out: 5xx or lost
          /\ phase' = Ambiguous /\ UNCHANGED <<server, result>>
       \/ \* not carried out: 429 / 403 rate limit (safe to send again)
          /\ phase' = "idle" /\ UNCHANGED <<server, result>>
    /\ UNCHANGED <<attempts, otherDone>>

Lookup ==
    /\ phase = "lookup"
    /\ LET found == IF Mode = "marker" THEN {i \in server : i.by = "me"} ELSE server
       IN IF found # {}
            THEN /\ phase' = "done"
                 /\ result' = CHOOSE i \in found : TRUE
            ELSE /\ phase' = "idle" /\ UNCHANGED result
    /\ UNCHANGED <<server, attempts, otherDone>>

\* Another device creates an item of the same name (at most once)
OtherCreate ==
    /\ ~otherDone
    /\ server' = server \cup {[by |-> "other", n |-> 0]}
    /\ otherDone' = TRUE
    /\ UNCHANGED <<phase, attempts, result>>

Next == Send \/ Outcome \/ Lookup \/ OtherCreate

Spec == Init /\ [][Next]_vars /\ WF_vars(Send \/ Outcome \/ Lookup)

-----------------------------------------------------------------------------
(* Safety *)

\* One upload never leaves two items behind
NoDuplicate == Cardinality({i \in server : i.by = "me"}) <= 1

\* The client never takes another device's item for its own upload (it would
\* then record content it never sent as synced)
OwnResult == phase = "done" => result.by = "me"

(* Liveness: the create ends, with the item or with an error *)
CreateEnds == <>(phase \in {"done", "failed"})
=============================================================================
