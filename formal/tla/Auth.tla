---------------------------- MODULE Auth ----------------------------
(***************************************************************************)
(* Token refresh, sign-out and sign-in of GoogleAuthService               *)
(* (src/cloud-adapters/google-drive/auth-service.ts) and the persistence   *)
(* callbacks of CredentialManager (src/services/credential-manager.ts).    *)
(*                                                                         *)
(* A token is <<account, session>>: each sign-in issues a new refresh      *)
(* token, and an access token is named after the refresh token it was     *)
(* obtained with. A refresh request remembers the                          *)
(* refresh token it was sent with and the session generation it started   *)
(* under. Google answers it later (any order relative to the client's own *)
(* steps), with a new access token, or invalid_grant once revoked.        *)
(*                                                                         *)
(* Guarded = TRUE models the code since PR #43 (results of a refresh that *)
(* started under an older generation are dropped, and only the refresh   *)
(* that owns the single-flight slot clears it). Guarded = FALSE models the *)
(* code before it; TLC finds the sign-out resurrection and the token mix.  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Accounts, None, Guarded, MaxGen

VARIABLES
    at,         \* in-memory access token (account or None)
    rt,         \* in-memory refresh token (account or None)
    gen,        \* session generation
    slot,       \* id of the refresh owning the single-flight slot, or 0
    reqs,       \* refresh requests: [id, rt, gen, state, result]
    nextId,
    stored,     \* persisted [at, rt] (SecretStorage)
    revoked,    \* refresh tokens Google has revoked
    intent      \* what the user did last: "in" (signed in as an account) or "out"

vars == <<at, rt, gen, slot, reqs, nextId, stored, revoked, intent>>

Tok == (Accounts \X (0..MaxGen)) \cup {None}
Acct(t) == IF t = None THEN None ELSE t[1]
States == {"sent", "ok", "invalid", "done"}

TypeOK ==
    /\ at \in Tok /\ rt \in Tok
    /\ gen \in Nat /\ slot \in Nat /\ nextId \in Nat
    /\ stored \in [at : Tok, rt : Tok]
    /\ revoked \subseteq Tok
    /\ intent \in {"out"} \cup Accounts

Init ==
    /\ \E a \in Accounts :
        /\ at = <<a, 0>> /\ rt = <<a, 0>> /\ intent = a
        /\ stored = [at |-> <<a, 0>>, rt |-> <<a, 0>>]
    /\ gen = 0 /\ slot = 0 /\ reqs = {} /\ nextId = 1
    /\ revoked = {}

\* refreshTokens(): single flight, sent with the current refresh token
StartRefresh ==
    /\ rt # None
    /\ slot = 0
    /\ nextId <= 3
    /\ reqs' = reqs \cup {[id |-> nextId, rt |-> rt, gen |-> gen, state |-> "sent"]}
    /\ slot' = nextId
    /\ nextId' = nextId + 1
    /\ UNCHANGED <<at, rt, gen, stored, revoked, intent>>

\* Google answers a request (server side, at any time)
Answer(r) ==
    /\ r.state = "sent"
    /\ reqs' = (reqs \ {r}) \cup
        {[r EXCEPT !.state = IF r.rt \in revoked THEN "invalid" ELSE "ok"]}
    /\ UNCHANGED <<at, rt, gen, slot, nextId, stored, revoked, intent>>

Current(r) == ~Guarded \/ r.gen = gen
ReleaseSlot(r) == IF ~Guarded \/ slot = r.id THEN 0 ELSE slot

\* The client applies a success: new access token of r.rt's account,
\* then onTokenRefresh persists both tokens when both are set
ApplyOk(r) ==
    /\ r.state = "ok"
    /\ reqs' = (reqs \ {r}) \cup {[r EXCEPT !.state = "done"]}
    /\ slot' = ReleaseSlot(r)
    /\ IF Current(r)
        THEN /\ at' = r.rt
             /\ stored' = IF r.rt # None /\ rt # None
                            THEN [at |-> r.rt, rt |-> rt] ELSE stored
        ELSE UNCHANGED <<at, stored>>
    /\ UNCHANGED <<rt, gen, nextId, revoked, intent>>

\* invalid_grant: clear tokens, onAuthFailure clears the stored credentials
ApplyInvalid(r) ==
    /\ r.state = "invalid"
    /\ reqs' = (reqs \ {r}) \cup {[r EXCEPT !.state = "done"]}
    /\ slot' = ReleaseSlot(r)
    /\ IF Current(r)
        THEN /\ at' = None /\ rt' = None
             /\ stored' = [at |-> None, rt |-> None]
        ELSE UNCHANGED <<at, rt, stored>>
    /\ UNCHANGED <<gen, nextId, revoked, intent>>

\* adapterLogout(): logout() (bumps the generation, frees the slot, revokes),
\* then the empty credentials are saved
SignOut ==
    /\ intent # "out"
    /\ gen < MaxGen
    /\ gen' = gen + 1
    /\ at' = None /\ rt' = None /\ slot' = 0
    /\ revoked' = IF rt # None THEN revoked \cup {rt} ELSE revoked
    /\ stored' = [at |-> None, rt |-> None]
    /\ intent' = "out"
    /\ UNCHANGED <<reqs, nextId>>

\* Sign-in callback: setTokens + saveCredentials (a new refresh token bumps the generation)
SignIn(a) ==
    /\ intent = "out"
    /\ gen < MaxGen
    /\ gen' = gen + 1
    /\ at' = <<a, gen + 1>> /\ rt' = <<a, gen + 1>>
    /\ stored' = [at |-> <<a, gen + 1>>, rt |-> <<a, gen + 1>>]
    /\ intent' = a
    /\ UNCHANGED <<slot, reqs, nextId, revoked>>

Next ==
    \/ StartRefresh
    \/ \E r \in reqs : Answer(r) \/ ApplyOk(r) \/ ApplyInvalid(r)
    \/ SignOut
    \/ \E a \in Accounts : SignIn(a)

Spec == Init /\ [][Next]_vars /\ WF_vars(\E r \in reqs : Answer(r) \/ ApplyOk(r) \/ ApplyInvalid(r))

-----------------------------------------------------------------------------
(* Safety *)

\* After sign-out nothing brings a token back, in memory or in storage
SignedOutStaysOut ==
    intent = "out" => /\ at = None /\ rt = None
                      /\ stored.at = None /\ stored.rt = None

\* The access token held always comes from the refresh token held (never an
\* access token of another account, or of an earlier sign-in, next to it)
NoMixedTokens ==
    /\ (at # None /\ rt # None) => at = rt
    /\ (stored.at # None /\ stored.rt # None) => stored.at = stored.rt

\* While signed in, what is held belongs to the signed-in account
TokensOfSignedInAccount ==
    intent # "out" => /\ Acct(at) \in {intent, None} /\ Acct(rt) \in {intent, None}
                      /\ Acct(stored.rt) \in {intent, None}

\* Single flight: at most one unanswered request of the current session
SingleFlight ==
    Cardinality({r \in reqs : r.gen = gen /\ r.state # "done"}) <= 1

(* Liveness: every refresh request is eventually finished, so a caller   *)
(* awaiting refreshTokens() never hangs and the slot is freed.           *)
RefreshesFinish == \A i \in 1..3 : [](\E r \in reqs : r.id = i) => <>(\E r \in reqs : r.id = i /\ r.state = "done")
=============================================================================
