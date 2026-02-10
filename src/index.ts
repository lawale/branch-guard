import { Probot } from "probot";
import type { ApplicationFunctionOptions } from "probot/lib/types.js";
import { registerCheck } from "./checks/index.js";
import { FilePresenceCheck } from "./checks/file-presence.js";
import { FilePairCheck } from "./checks/file-pair.js";
import { ExternalStatusCheck } from "./checks/external-status.js";
import { registerPullRequestHandler } from "./handlers/pull-request.js";
import { registerPushHandler } from "./handlers/push.js";
import { registerCheckSuiteHandler } from "./handlers/check-suite.js";
import { registerCheckRunHandler } from "./handlers/check-run.js";
import { registerIssueCommentHandler } from "./handlers/issue-comment.js";

// Register check types
registerCheck(new FilePresenceCheck());
registerCheck(new FilePairCheck());
registerCheck(new ExternalStatusCheck());

export default function app(robot: Probot, { getRouter }: ApplicationFunctionOptions): void {
  // Health check endpoint for container orchestration
  if (getRouter) {
    const router = getRouter();
    router.get("/healthz", (_req: any, res: any) => {
      res.json({ status: "ok", version: "0.1.0" });
    });
  }

  // Register webhook handlers
  registerPullRequestHandler(robot);
  registerPushHandler(robot);
  registerCheckSuiteHandler(robot);
  registerCheckRunHandler(robot);
  registerIssueCommentHandler(robot);

  robot.log.info("BranchGuard app loaded");
}
