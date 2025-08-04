import Docker from "dockerode";
import { simpleGit, SimpleGit } from "simple-git";
import chalk from "chalk";
import { CredentialManager } from "./credentials";
import { GitMonitor } from "./git-monitor";
import { ContainerManager } from "./container";
import { UIManager } from "./ui";
import { WebUIServer } from "./web-server";
import { SandboxConfig } from "./types";
import { getDockerConfig, isPodman } from "./docker-config";
import path from "path";

export class ClaudeSandbox {
  private docker: Docker;
  private git: SimpleGit;
  private config: SandboxConfig;
  private credentialManager: CredentialManager;
  private gitMonitor: GitMonitor;
  private containerManager: ContainerManager;
  private ui: UIManager;
  private webServer?: WebUIServer;

  constructor(config: SandboxConfig) {
    this.config = config;
    const dockerConfig = getDockerConfig(config.dockerSocketPath);
    this.docker = new Docker(dockerConfig);

    // Log if using Podman
    if (isPodman(dockerConfig)) {
      console.log(chalk.blue("Detected Podman socket"));
    }

    this.git = simpleGit();
    this.credentialManager = new CredentialManager();
    this.gitMonitor = new GitMonitor(this.git);
    this.containerManager = new ContainerManager(this.docker, config);
    this.ui = new UIManager();
  }

  async run(): Promise<void> {
    try {
      // Check git repository status
      const gitStatus = await this.checkGitStatus();
      
      // Auto-adjust config for non-git environments
      if (!gitStatus.isGitRepo) {
        // Automatically disable git-related features in non-git environments
        this.config.autoPush = false;
        this.config.autoCreatePR = false;
        console.log(
          chalk.yellow("⚠️ Auto-disabled git features (autoPush, autoCreatePR) for non-git environment"),
        );
      }
      
      // Determine target branch based on config options (but don't checkout in host repo)
      let branchName = "";
      let prFetchRef = "";
      let remoteFetchRef = "";

      if (!gitStatus.isGitRepo) {
        // Non-git environment: use a simple branch name
        branchName = this.config.targetBranch || "claude-session";
        console.log(
          chalk.yellow(`⚠️ Not a git repository. Running in non-git mode.`),
        );
        console.log(
          chalk.blue(`Will create workspace with branch name: ${branchName}`),
        );
      } else {
        // Git environment: handle git-specific options
        console.log(chalk.blue(`Current branch: ${gitStatus.currentBranch}`));

        if (this.config.prNumber) {
          // Get PR branch name from GitHub but don't checkout locally
          console.log(chalk.blue(`Getting PR #${this.config.prNumber} info...`));
          try {
            const { execSync } = require("child_process");

            // Check if gh command is available
            try {
              execSync("which gh", { stdio: "ignore" });
            } catch {
              throw new Error("GitHub CLI (gh) is not installed or not available in PATH");
            }

            // Get PR info to find the actual branch name
            const prInfo = execSync(
              `gh pr view ${this.config.prNumber} --json headRefName`,
              {
                encoding: "utf-8",
                cwd: process.cwd(),
              },
            );
            const prData = JSON.parse(prInfo);
            branchName = prData.headRefName;
            prFetchRef = `pull/${this.config.prNumber}/head:${branchName}`;

            console.log(
              chalk.blue(
                `PR #${this.config.prNumber} uses branch: ${branchName}`,
              ),
            );
            console.log(
              chalk.blue(`Will setup container with PR branch: ${branchName}`),
            );
          } catch (error) {
            console.error(
              chalk.red(`✗ Failed to get PR #${this.config.prNumber} info:`),
              error,
            );
            throw error;
          }
        } else if (this.config.remoteBranch) {
          // Parse remote branch but don't checkout locally
          console.log(
            chalk.blue(
              `Will setup container with remote branch: ${this.config.remoteBranch}`,
            ),
          );
          try {
            // Parse remote/branch format
            const parts = this.config.remoteBranch.split("/");
            if (parts.length < 2) {
              throw new Error(
                'Remote branch must be in format "remote/branch" (e.g., "origin/feature-branch")',
              );
            }

            const remote = parts[0];
            const branch = parts.slice(1).join("/");

            console.log(chalk.blue(`Remote: ${remote}, Branch: ${branch}`));
            branchName = branch;
            remoteFetchRef = `${remote}/${branch}`;
          } catch (error) {
            console.error(
              chalk.red(
                `✗ Failed to parse remote branch ${this.config.remoteBranch}:`,
              ),
              error,
            );
            throw error;
          }
        } else {
          // Use target branch from config or generate one
          branchName =
            this.config.targetBranch ||
            (() => {
              const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, "-")
                .split("T")[0];
              return `claude/${timestamp}-${Date.now()}`;
            })();
          console.log(
            chalk.blue(`Will create branch in container: ${branchName}`),
          );
        }
      }

      // Discover credentials (optional - don't fail if not found)
      const credentials = await this.credentialManager.discover();

      // Prepare container environment
      const containerConfig = await this.prepareContainer(
        branchName,
        credentials,
        prFetchRef,
        remoteFetchRef,
        gitStatus,
      );

      // Start container
      const containerId = await this.containerManager.start(containerConfig);
      console.log(
        chalk.green(`✓ Started container: ${containerId.substring(0, 12)}`),
      );

      // Start monitoring for commits only if in git mode
      if (gitStatus.isGitRepo && !this.config.noGit) {
        this.gitMonitor.on("commit", async (commit) => {
          await this.handleCommit(commit);
        });

        await this.gitMonitor.start(branchName);
        console.log(chalk.blue("✓ Git monitoring started"));
      } else {
        console.log(chalk.yellow("⚠️ Git monitoring disabled (non-git mode)"));
      }

      // Always launch web UI
      this.webServer = new WebUIServer(this.docker);

      // Pass repo info to web server
      this.webServer.setRepoInfo(process.cwd(), branchName);

      const webUrl = await this.webServer.start();

      // Open browser to the web UI with container ID
      const fullUrl = `${webUrl}?container=${containerId}`;
      await this.webServer.openInBrowser(fullUrl);

      console.log(chalk.green(`\n✓ Web UI available at: ${fullUrl}`));
      console.log(
        chalk.yellow("Keep this terminal open to maintain the session"),
      );

      // Keep the process running
      await new Promise(() => {}); // This will keep the process alive
    } catch (error) {
      console.error(chalk.red("Error:"), error);
      throw error;
    }
  }

  private async checkGitStatus(): Promise<{
    isGitRepo: boolean;
    currentBranch?: string;
  }> {
    try {
      // If --no-git flag is set, always return non-git status
      if (this.config.noGit) {
        console.log(chalk.yellow("⚠️ Git functionality disabled by --no-git flag"));
        return { isGitRepo: false };
      }

      // Use configured working directory or fall back to current directory
      const workDir = this.config.workingDirectory || process.cwd();
      console.log(chalk.gray(`🔍 Git check in directory: ${workDir}`));

      // Check if working directory is a git working tree
      const { exec } = require("child_process");
      const { promisify } = require("util");
      const execAsync = promisify(exec);
      
      try {
        // Check if working directory is in a git working tree and has .git
        await execAsync("git rev-parse --is-inside-work-tree", { 
          cwd: workDir 
        });
        
        // Also check if .git directory exists in working directory or its parents
        await execAsync("git rev-parse --git-dir", { 
          cwd: workDir 
        });
        
        // If we get here, we're in a valid git working tree
        // Create a new git instance for the correct working directory
        const workDirGit = simpleGit(workDir);
        const currentBranch = await workDirGit.branchLocal();
        return {
          isGitRepo: true,
          currentBranch: currentBranch.current,
        };
      } catch (gitError) {
        // Not in a git working tree or git commands failed
        console.log(chalk.gray(`🔍 Git check failed in ${workDir}: not a git repository`));
        return { isGitRepo: false };
      }
    } catch (error) {
      // If any operations fail, treat as non-git
      return { isGitRepo: false };
    }
  }

  private async prepareContainer(
    branchName: string,
    credentials: any,
    prFetchRef?: string,
    remoteFetchRef?: string,
    gitStatus?: { isGitRepo: boolean; currentBranch?: string },
  ): Promise<any> {
    // Use configured working directory or fall back to current directory
    const workDir = this.config.workingDirectory || process.cwd();
    const repoName = path.basename(workDir);

    return {
      branchName,
      credentials,
      workDir,
      repoName,
      dockerImage: this.config.dockerImage || "claude-sandbox:latest",
      prFetchRef,
      remoteFetchRef,
      gitStatus, // Pass git status to container manager
    };
  }

  private async handleCommit(commit: any): Promise<void> {
    // Show commit notification
    this.ui.showCommitNotification(commit);

    // Show diff
    const diff = await this.git.diff(["HEAD~1", "HEAD"]);
    this.ui.showDiff(diff);

    // Ask user what to do
    const action = await this.ui.askCommitAction();

    switch (action) {
      case "nothing":
        console.log(chalk.blue("Continuing..."));
        break;
      case "push":
        await this.pushBranch();
        break;
      case "push-pr":
        await this.pushBranchAndCreatePR();
        break;
      case "exit":
        await this.cleanup();
        process.exit(0);
    }
  }

  private async pushBranch(): Promise<void> {
    const currentBranch = await this.git.branchLocal();
    await this.git.push("origin", currentBranch.current);
    console.log(chalk.green(`✓ Pushed branch: ${currentBranch.current}`));
  }

  private async pushBranchAndCreatePR(): Promise<void> {
    await this.pushBranch();

    // Use gh CLI to create PR
    const { execSync } = require("child_process");
    try {
      // Check if gh command is available
      try {
        execSync("which gh", { stdio: "ignore" });
      } catch {
        throw new Error("GitHub CLI (gh) is not installed or not available in PATH");
      }

      execSync("gh pr create --fill", { stdio: "inherit" });
      console.log(chalk.green("✓ Created pull request"));
    } catch (error) {
      console.error(
        chalk.yellow(
          "Could not create PR automatically. Please create it manually.",
        ),
      );
    }
  }

  async startContainer(): Promise<string> {
    try {
      // Check git repository status
      const gitStatus = await this.checkGitStatus();

      // Auto-adjust config for non-git environments
      if (!gitStatus.isGitRepo) {
        // Automatically disable git-related features in non-git environments
        this.config.autoPush = false;
        this.config.autoCreatePR = false;
        console.log(
          chalk.yellow("⚠️ Auto-disabled git features (autoPush, autoCreatePR) for non-git environment"),
        );
      }

      // Determine target branch based on config options
      let branchName = "";
      let prFetchRef = "";
      let remoteFetchRef = "";

      if (!gitStatus.isGitRepo) {
        // Non-git environment: use a simple branch name
        branchName = this.config.targetBranch || "claude-session";
        console.log(
          chalk.yellow(`⚠️ Not a git repository. Running in non-git mode.`),
        );
        console.log(
          chalk.blue(`Will create workspace with branch name: ${branchName}`),
        );
      } else {
        // Git environment: handle git-specific options
        console.log(chalk.blue(`Current branch: ${gitStatus.currentBranch}`));

        if (this.config.prNumber) {
          // Handle PR checkout (same logic as run())
          console.log(chalk.blue(`Getting PR #${this.config.prNumber} info...`));
          try {
            const { execSync } = require("child_process");
            try {
              execSync("which gh", { stdio: "ignore" });
            } catch {
              throw new Error("GitHub CLI (gh) is not installed or not available in PATH");
            }

            const prInfo = execSync(
              `gh pr view ${this.config.prNumber} --json headRefName`,
              {
                encoding: "utf-8",
                cwd: process.cwd(),
              },
            );
            const prData = JSON.parse(prInfo);
            branchName = prData.headRefName;
            prFetchRef = `pull/${this.config.prNumber}/head:${branchName}`;

            console.log(
              chalk.blue(
                `PR #${this.config.prNumber} uses branch: ${branchName}`,
              ),
            );
          } catch (error) {
            console.error(
              chalk.red(`✗ Failed to get PR #${this.config.prNumber} info:`),
              error,
            );
            throw error;
          }
        } else if (this.config.remoteBranch) {
          // Handle remote branch checkout
          console.log(
            chalk.blue(
              `Will setup container with remote branch: ${this.config.remoteBranch}`,
            ),
          );
          try {
            const parts = this.config.remoteBranch.split("/");
            if (parts.length < 2) {
              throw new Error(
                'Remote branch must be in format "remote/branch" (e.g., "origin/feature-branch")',
              );
            }

            const remote = parts[0];
            const branch = parts.slice(1).join("/");

            console.log(chalk.blue(`Remote: ${remote}, Branch: ${branch}`));
            branchName = branch;
            remoteFetchRef = `${remote}/${branch}`;
          } catch (error) {
            console.error(
              chalk.red(
                `✗ Failed to parse remote branch ${this.config.remoteBranch}:`,
              ),
              error,
            );
            throw error;
          }
        } else {
          // Use target branch from config or generate one
          branchName =
            this.config.targetBranch ||
            (() => {
              const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, "-")
                .split("T")[0];
              return `claude/${timestamp}-${Date.now()}`;
            })();
          console.log(
            chalk.blue(`Will create branch in container: ${branchName}`),
          );
        }
      }

      // Discover credentials
      const credentials = await this.credentialManager.discover();

      // Prepare container environment
      const containerConfig = await this.prepareContainer(
        branchName,
        credentials,
        prFetchRef,
        remoteFetchRef,
        gitStatus,
      );

      // Start container and return ID
      const containerId = await this.containerManager.start(containerConfig);
      console.log(
        chalk.green(`✓ Started container: ${containerId.substring(0, 12)}`),
      );

      return containerId;
    } catch (error) {
      console.error(chalk.red("Error starting container:"), error);
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    await this.gitMonitor.stop();
    await this.containerManager.cleanup();
    if (this.webServer) {
      await this.webServer.stop();
    }
  }
}

export * from "./types";
