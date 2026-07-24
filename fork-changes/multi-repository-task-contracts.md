# Multi-repository task contracts

- Added a branded `TaskId` and the durable task status and projection shapes used by the
  multi-repository task model.
- Added optional task context to thread detail and shell contracts. Task context records immutable
  user or agent creation lineage while leaving historical standalone threads unchanged.
- Added an internal-task project visibility marker so task workspace projects can be hidden from
  ordinary project surfaces without soft-deleting them.
- Added the optional `taskThreads` execution-environment capability for safe client/server
  negotiation during rollout.
