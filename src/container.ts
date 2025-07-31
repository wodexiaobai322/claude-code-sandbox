import Docker from "dockerode";
import path from "path";
import { SandboxConfig, Credentials } from "./types";
import chalk from "chalk";

export class ContainerManager {
  private docker: Docker;
  private config: SandboxConfig;
  private containers: Map<string, Docker.Container> = new Map();

  constructor(docker: Docker, config: SandboxConfig) {
    this.docker = docker;
    this.config = config;
  }

  private getContainerName(): string {
    // If user explicitly provided a custom name via --name option,
    // use it as-is without adding timestamp
    if (this.config.customContainerName && this.config.containerPrefix) {
      return this.config.containerPrefix;
    }
    
    // Default behavior: add timestamp to avoid conflicts
    const prefix = this.config.containerPrefix || "claude-code-sandbox";
    return `${prefix}-${Date.now()}`;
  }

  async start(containerConfig: any): Promise<string> {
    // Build or pull image
    await this.ensureImage();

    // Create container
    const container = await this.createContainer(containerConfig);
    this.containers.set(container.id, container);

    // Start container
    await container.start();
    console.log(chalk.green("✓ Container started"));

    // Copy working directory into container
    console.log(chalk.blue("• Copying files into container..."));
    try {
      await this._copyWorkingDirectory(
        container, 
        containerConfig.workDir,
        containerConfig.gitStatus
      );
      console.log(chalk.green("✓ Files copied"));

      // Copy Claude configuration if it exists
      await this._copyClaudeConfig(container);

      // Copy git configuration if it exists (only in git mode)
      if (containerConfig.gitStatus?.isGitRepo) {
        await this._copyGitConfig(container);
      } else {
        console.log(chalk.yellow("• Skipping git config copy (non-git mode)"));
      }
    } catch (error) {
      console.error(chalk.red("✗ File copy failed:"), error);
      // Clean up container on failure
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
      this.containers.delete(container.id);
      throw error;
    }

    // Give the container a moment to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(chalk.green("✓ Container ready"));

    // Set up git branch and startup script (only in git mode)
    if (containerConfig.gitStatus?.isGitRepo) {
      await this.setupGitAndStartupScript(
        container,
        containerConfig.branchName,
        containerConfig.prFetchRef,
        containerConfig.remoteFetchRef,
      );
    } else {
      // In non-git mode, just create the startup script without git setup
      await this.setupStartupScriptOnly(container);
    }

    // Run setup commands
    await this.runSetupCommands(container);

    return container.id;
  }

  private async ensureImage(): Promise<void> {
    const imageName = this.config.dockerImage || "claude-code-sandbox:latest";

    // Check if image already exists
    try {
      await this.docker.getImage(imageName).inspect();
      console.log(chalk.green(`✓ Using existing image: ${imageName}`));
      return;
    } catch (error) {
      console.log(chalk.blue(`• Building image: ${imageName}...`));
    }

    // Check if we need to build from Dockerfile
    if (this.config.dockerfile) {
      await this.buildImage(this.config.dockerfile, imageName);
    } else {
      // Use default Dockerfile
      await this.buildDefaultImage(imageName);
    }
  }

  private async buildDefaultImage(imageName: string): Promise<void> {
    const dockerfile = `
FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set locale to support Chinese characters
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Install system dependencies including Chinese language support
RUN apt-get update && apt-get install -y \\
    curl \\
    git \\
    openssh-client \\
    python3 \\
    python3-pip \\
    build-essential \\
    sudo \\
    vim \\
    ca-certificates \\
    gnupg \\
    locales \\
    language-pack-zh-hans \\
    && rm -rf /var/lib/apt/lists/*

# Generate UTF-8 locale
RUN locale-gen en_US.UTF-8 zh_CN.UTF-8 && \\
    update-locale LANG=C.UTF-8

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
    && apt-get install -y nodejs

# Skip GitHub CLI installation to avoid slow network requests

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code@latest

# Create a non-root user with sudo privileges
RUN useradd -m -s /bin/bash claude && \\
    echo 'claude ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \\
    usermod -aG sudo claude

# Create workspace directory and set ownership
RUN mkdir -p /workspace && \\
    chown -R claude:claude /workspace

# Switch to non-root user
USER claude
WORKDIR /workspace

# Set up entrypoint
ENTRYPOINT ["/bin/bash", "-c"]
`;
    /*
RUN echo '#!/bin/bash\\n\\
# Allow the initial branch creation\\n\\
if [ ! -f /tmp/.branch-created ]; then\\n\\
    /usr/bin/git "$@"\\n\\
    if [[ "$1" == "checkout" ]] && [[ "$2" == "-b" ]]; then\\n\\
        touch /tmp/.branch-created\\n\\
    fi\\n\\
else\\n\\
    # After initial branch creation, prevent switching\\n\\
    if [[ "$1" == "checkout" ]] && [[ "$2" != "-b" ]]; then\\n\\
        echo "Branch switching is disabled in claude-code-sandbox"\\n\\
        exit 1\\n\\
    fi\\n\\
    if [[ "$1" == "switch" ]]; then\\n\\
        echo "Branch switching is disabled in claude-code-sandbox"\\n\\
        exit 1\\n\\
    fi\\n\\
    /usr/bin/git "$@"\\n\\
fi' > /usr/local/bin/git && \\
    chmod +x /usr/local/bin/git
# Create startup script
RUN echo '#!/bin/bash\\n\\
echo "Waiting for attachment..."\\n\\
sleep 2\\n\\
cd /workspace\\n\\
git checkout -b "$1"\\n\\
echo "Starting Claude Code on branch $1..."\\n\\
exec claude --dangerously-skip-permissions' > /start-claude.sh && \\
    chmod +x /start-claude.sh */
    // Build image from string
    const tarStream = require("tar-stream");
    const pack = tarStream.pack();

    // Add Dockerfile to tar
    pack.entry({ name: "Dockerfile" }, dockerfile, (err: any) => {
      if (err) throw err;
      pack.finalize();
    });

    // Convert to buffer for docker
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: any) => chunks.push(chunk));

    await new Promise((resolve) => {
      pack.on("end", resolve);
    });

    const tarBuffer = Buffer.concat(chunks);
    const buildStream = await this.docker.buildImage(tarBuffer as any, {
      t: imageName,
    });

    // Wait for build to complete
    await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        buildStream as any,
        (err: any, res: any) => {
          if (err) reject(err);
          else resolve(res);
        },
        (event: any) => {
          if (event.stream) {
            process.stdout.write(event.stream);
          }
        },
      );
    });
  }

  private async buildImage(
    dockerfilePath: string,
    imageName: string,
  ): Promise<void> {
    const buildContext = path.dirname(dockerfilePath);

    const buildStream = await this.docker.buildImage(
      {
        context: buildContext,
        src: [path.basename(dockerfilePath)],
      },
      {
        dockerfile: path.basename(dockerfilePath),
        t: imageName,
      },
    );

    await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        buildStream as any,
        (err: any, res: any) => {
          if (err) reject(err);
          else resolve(res);
        },
        (event: any) => {
          if (event.stream) {
            process.stdout.write(event.stream);
          }
        },
      );
    });
  }

  private async createContainer(
    containerConfig: any,
  ): Promise<Docker.Container> {
    const { credentials, workDir } = containerConfig;

    // Prepare environment variables
    const env = this.prepareEnvironment(credentials);

    // Prepare volumes
    const volumes = this.prepareVolumes(workDir, credentials);

    // Create container
    const containerName = this.getContainerName();
    const container = await this.docker.createContainer({
      Image: this.config.dockerImage || "claude-code-sandbox:latest",
      name: containerName,
      Env: env,
      HostConfig: {
        Binds: volumes,
        AutoRemove: false,
        NetworkMode: process.platform === "linux" ? "host" : "bridge",
      },
      WorkingDir: "/workspace",
      Cmd: ["/bin/bash", "-l"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
    });

    return container;
  }

  private prepareEnvironment(credentials: Credentials): string[] {
    const env: string[] = [];

    // Load environment variables from .env file if specified
    if (this.config.envFile) {
      const fs = require("fs");
      const path = require("path");

      try {
        const envFilePath = path.resolve(this.config.envFile);
        if (fs.existsSync(envFilePath)) {
          console.log(
            chalk.blue(`• Loading environment from ${this.config.envFile}...`),
          );

          const envContent = fs.readFileSync(envFilePath, "utf-8");
          const lines = envContent.split("\n");

          for (const line of lines) {
            const trimmedLine = line.trim();

            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith("#")) {
              continue;
            }

            // Skip lines without = sign
            if (!trimmedLine.includes("=")) {
              continue;
            }

            // Parse key=value, handling values with = signs
            const firstEqualIndex = trimmedLine.indexOf("=");
            const key = trimmedLine.substring(0, firstEqualIndex).trim();
            let value = trimmedLine.substring(firstEqualIndex + 1).trim();

            // Remove surrounding quotes if present
            if (
              (value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))
            ) {
              value = value.slice(1, -1);
            }

            if (key) {
              env.push(`${key}=${value}`);
            }
          }

          console.log(
            chalk.green(
              `✓ Loaded ${env.length} environment variables from ${this.config.envFile}`,
            ),
          );
        } else {
          console.log(
            chalk.yellow(
              `⚠ Environment file ${this.config.envFile} not found`,
            ),
          );
        }
      } catch (error) {
        console.error(
          chalk.yellow(
            `⚠ Failed to load environment file ${this.config.envFile}:`,
          ),
          error,
        );
      }
    }

    // Claude credentials from discovery
    if (credentials.claude) {
      switch (credentials.claude.type) {
        case "api_key":
          env.push(`ANTHROPIC_API_KEY=${credentials.claude.value}`);
          break;
        case "bedrock":
          env.push("CLAUDE_CODE_USE_BEDROCK=1");
          if (credentials.claude.region) {
            env.push(`AWS_REGION=${credentials.claude.region}`);
          }
          break;
        case "vertex":
          env.push("CLAUDE_CODE_USE_VERTEX=1");
          if (credentials.claude.project) {
            env.push(`GOOGLE_CLOUD_PROJECT=${credentials.claude.project}`);
          }
          break;
      }
    } else if (process.env.ANTHROPIC_API_KEY) {
      // If no Claude credentials were discovered but ANTHROPIC_API_KEY is in environment, pass it through
      env.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }

    // GitHub token - check multiple sources
    if (credentials.github?.token) {
      env.push(`GITHUB_TOKEN=${credentials.github.token}`);
    } else if (process.env.GITHUB_TOKEN) {
      // Pass through from environment
      env.push(`GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
    } else if (process.env.GH_TOKEN) {
      // GitHub CLI uses GH_TOKEN
      env.push(`GITHUB_TOKEN=${process.env.GH_TOKEN}`);
      env.push(`GH_TOKEN=${process.env.GH_TOKEN}`);
    }

    // Pass through git author info if available
    if (process.env.GIT_AUTHOR_NAME) {
      env.push(`GIT_AUTHOR_NAME=${process.env.GIT_AUTHOR_NAME}`);
    }
    if (process.env.GIT_AUTHOR_EMAIL) {
      env.push(`GIT_AUTHOR_EMAIL=${process.env.GIT_AUTHOR_EMAIL}`);
    }
    if (process.env.GIT_COMMITTER_NAME) {
      env.push(`GIT_COMMITTER_NAME=${process.env.GIT_COMMITTER_NAME}`);
    }
    if (process.env.GIT_COMMITTER_EMAIL) {
      env.push(`GIT_COMMITTER_EMAIL=${process.env.GIT_COMMITTER_EMAIL}`);
    }

    // Additional config
    env.push("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
    if (this.config.maxThinkingTokens) {
      env.push(`MAX_THINKING_TOKENS=${this.config.maxThinkingTokens}`);
    }
    if (this.config.bashTimeout) {
      env.push(`BASH_MAX_TIMEOUT_MS=${this.config.bashTimeout}`);
    }

    // Fix localhost URLs for container environment
    if (process.platform !== "linux") {
      env.forEach((envVar, index) => {
        if (envVar.includes("ANTHROPIC_BASE_URL=http://127.0.0.1") || envVar.includes("ANTHROPIC_BASE_URL=http://localhost")) {
          env[index] = envVar.replace(/http:\/\/(127\.0\.0\.1|localhost)/, "http://host.docker.internal");
          console.log(chalk.blue(`• Fixed API URL for container: ${env[index]}`));
        }
      });
    } else {
      console.log(chalk.blue("• Using host network mode on Linux - localhost URLs will work directly"));
    }

    // Add custom environment variables
    if (this.config.environment) {
      console.log(chalk.blue("• Loading custom environment variables:"));
      Object.entries(this.config.environment).forEach(([key, value]) => {
        console.log(chalk.green(`  ${key}=${value}`));
        env.push(`${key}=${value}`);
      });
    } else {
      console.log(chalk.yellow("• No custom environment variables found in config"));
    }

    console.log(chalk.blue(`• Total environment variables: ${env.length}`));
    return env;
  }

  private prepareVolumes(
    _workDir: string,
    _credentials: Credentials,
  ): string[] {
    // NO MOUNTING workspace - we'll copy files instead
    const volumes: string[] = [];

    // NO SSH mounting - we'll use GitHub tokens instead

    // Add custom volumes (legacy format)
    if (this.config.volumes) {
      volumes.push(...this.config.volumes);
    }

    // Add mount configurations (new format)
    if (this.config.mounts) {
      const path = require("path");
      const fs = require("fs");
      const os = require("os");

      for (const mount of this.config.mounts) {
        try {
          // Expand environment variables in source path
          let expandedSource = mount.source.replace(/\$HOME/g, os.homedir());
          expandedSource = expandedSource.replace(
            /\$(\w+)/g,
            (match, varName) => {
              return process.env[varName] || match;
            },
          );

          // Resolve the source path
          const sourcePath = path.isAbsolute(expandedSource)
            ? expandedSource
            : path.resolve(process.cwd(), expandedSource);

          // Check if source exists
          if (!fs.existsSync(sourcePath)) {
            console.log(
              chalk.yellow(
                `⚠ Mount source does not exist: ${mount.source} (resolved to ${sourcePath})`,
              ),
            );
            continue;
          }

          // Expand environment variables in target path
          let expandedTarget = mount.target.replace(/\$HOME/g, "/home/claude");
          expandedTarget = expandedTarget.replace(
            /\$(\w+)/g,
            (match, varName) => {
              // For container paths, we need to use container's environment
              if (varName === "HOME") return "/home/claude";
              return match; // Keep other variables as-is
            },
          );

          // Ensure target path is absolute
          const targetPath = path.isAbsolute(expandedTarget)
            ? expandedTarget
            : path.join("/workspace", expandedTarget);

          // Create mount string
          const mountString = mount.readonly
            ? `${sourcePath}:${targetPath}:ro`
            : `${sourcePath}:${targetPath}`;

          volumes.push(mountString);
          console.log(
            chalk.blue(
              `✓ Mounting ${mount.source} → ${targetPath}${mount.readonly ? " (read-only)" : ""}`,
            ),
          );
        } catch (error) {
          console.error(
            chalk.yellow(`⚠ Failed to process mount ${mount.source}:`),
            error,
          );
        }
      }
    }

    return volumes;
  }

  private async _copyWorkingDirectory(
    container: Docker.Container,
    workDir: string,
    gitStatus?: { isGitRepo: boolean; currentBranch?: string },
  ): Promise<void> {
    const { execSync } = require("child_process");
    const fs = require("fs");

    // Helper function to get tar flags safely
    const getTarFlags = () => {
      try {
        // Test if --no-xattrs is supported by checking tar help
        execSync("tar --help 2>&1 | grep -q no-xattrs", { stdio: "pipe" });
        return "--no-xattrs";
      } catch {
        // --no-xattrs not supported, use standard tar
        return "";
      }
    };

    try {
      let allFiles: string[] = [];

      if (gitStatus?.isGitRepo) {
        // Git mode: use git commands to get file lists
        console.log(chalk.blue("• Using git-based file discovery"));

        // Get list of git-tracked files (including uncommitted changes)
        const trackedFiles = execSync("git ls-files", {
          cwd: workDir,
          encoding: "utf-8",
        })
          .trim()
          .split("\n")
          .filter((f: string) => f);

        // Get list of untracked files that aren't ignored (only if includeUntracked is true)
        let untrackedFiles: string[] = [];
        if (this.config.includeUntracked) {
          untrackedFiles = execSync("git ls-files --others --exclude-standard", {
            cwd: workDir,
            encoding: "utf-8",
          })
            .trim()
            .split("\n")
            .filter((f: string) => f);
        }

        // Combine all files
        allFiles = [...trackedFiles, ...untrackedFiles];
      } else {
        // Non-git mode: use filesystem traversal
        console.log(chalk.blue("• Using filesystem-based file discovery"));
        allFiles = this.getAllFiles(workDir);
      }

      console.log(chalk.blue(`• Copying ${allFiles.length} files...`));

      // Create tar archive
      const tarFile = `/tmp/claude-sandbox-${Date.now()}.tar`;

      if (gitStatus?.isGitRepo) {
        // Git mode: try git archive first, fallback to filesystem if it fails
        try {
          let untrackedFiles: string[] = [];
          if (this.config.includeUntracked) {
            untrackedFiles = execSync("git ls-files --others --exclude-standard", {
              cwd: workDir,
              encoding: "utf-8",
            })
              .trim()
              .split("\n")
              .filter((f: string) => f);
          }

          // First create archive of tracked files using git archive
          execSync(`git archive --format=tar -o "${tarFile}" HEAD`, {
            cwd: workDir,
            stdio: "pipe",
          });

          // Add untracked files if any
          if (untrackedFiles.length > 0) {
            // Create a file list for tar
            const fileListPath = `/tmp/claude-sandbox-files-${Date.now()}.txt`;
            fs.writeFileSync(fileListPath, untrackedFiles.join("\n"));

            // Append untracked files to the tar
            execSync(`tar -rf "${tarFile}" --files-from="${fileListPath}"`, {
              cwd: workDir,
              stdio: "pipe",
            });

            fs.unlinkSync(fileListPath);
          }
        } catch (gitError) {
          // Git archive failed (e.g., no commits, untracked directory)
          // Fall back to filesystem-based file discovery
          console.log(chalk.yellow("• Git archive failed, falling back to filesystem discovery"));
          allFiles = this.getAllFiles(workDir);
          
          // Create tar archive from file list
          if (allFiles.length > 0) {
            const fileListPath = `/tmp/claude-sandbox-files-${Date.now()}.txt`;
            fs.writeFileSync(fileListPath, allFiles.join("\n"));

            const tarFlags = getTarFlags();
            execSync(`tar -cf "${tarFile}" ${tarFlags} --files-from="${fileListPath}"`, {
              cwd: workDir,
              stdio: "pipe",
            });

            fs.unlinkSync(fileListPath);
          } else {
            // Create empty tar if no files
            execSync(`tar -cf "${tarFile}" --files-from=/dev/null`, {
              cwd: workDir,
              stdio: "pipe",
            });
          }
        }
      } else {
        // Non-git mode: create tar archive from file list
        if (allFiles.length > 0) {
          const fileListPath = `/tmp/claude-sandbox-files-${Date.now()}.txt`;
          fs.writeFileSync(fileListPath, allFiles.join("\n"));

          const tarFlags = getTarFlags();
          execSync(`tar -cf "${tarFile}" ${tarFlags} --files-from="${fileListPath}"`, {
            cwd: workDir,
            stdio: "pipe",
          });

          fs.unlinkSync(fileListPath);
        } else {
          // Create empty tar if no files
          execSync(`tar -cf "${tarFile}" --files-from=/dev/null`, {
            cwd: workDir,
            stdio: "pipe",
          });
        }
      }

      // Read and copy the tar file in chunks to avoid memory issues
      const stream = fs.createReadStream(tarFile);

      // Add timeout for putArchive
      const uploadPromise = container.putArchive(stream, {
        path: "/workspace",
      });

      // Wait for both upload and stream to complete
      await Promise.all([
        uploadPromise,
        new Promise<void>((resolve, reject) => {
          stream.on("end", () => {
            resolve();
          });
          stream.on("error", reject);
        }),
      ]);

      // Clean up
      fs.unlinkSync(tarFile);

      // Copy .git directory only in git mode
      if (gitStatus?.isGitRepo) {
        console.log(chalk.blue("• Copying git history..."));
        await this.copyGitHistory(container, workDir);
      } else {
        console.log(chalk.yellow("• Skipping git history copy (non-git mode)"));
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to copy files:"), error);
      throw error;
    }
  }

  private getAllFiles(workDir: string): string[] {
    const fs = require("fs");
    const path = require("path");
    
    const files: string[] = [];
    const ignoredDirs = new Set([
      '.git', 'node_modules', '__pycache__', '.pytest_cache', 
      'venv', '.venv', 'env', '.env', 'dist', 'build', 
      '.DS_Store', 'thumbs.db', '.idea', '.vscode'
    ]);
    
    const getAllFilesRecursive = (dir: string, relativePath: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativeFilePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
          
          if (entry.isDirectory()) {
            if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
              getAllFilesRecursive(fullPath, relativeFilePath);
            }
          } else if (entry.isFile()) {
            // Skip hidden files and common ignored files
            if (!entry.name.startsWith('.') && !entry.name.includes('~')) {
              files.push(relativeFilePath);
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
        console.warn(`Warning: Could not read directory ${dir}: ${error}`);
      }
    };
    
    getAllFilesRecursive(workDir);
    return files;
  }

  private async copyGitHistory(container: Docker.Container, workDir: string): Promise<void> {
    const { execSync } = require("child_process");
    const fs = require("fs");
    
    // Check if .git directory exists first
    if (!fs.existsSync(`${workDir}/.git`)) {
      console.log(chalk.yellow("• No .git directory found, skipping git history copy"));
      return;
    }
    
    // Helper function to get tar flags safely
    const getTarFlags = () => {
      try {
        // Test if --no-xattrs is supported by checking tar help
        execSync("tar --help 2>&1 | grep -q no-xattrs", { stdio: "pipe" });
        return "--no-xattrs";
      } catch {
        // --no-xattrs not supported, use standard tar
        return "";
      }
    };

    const gitTarFile = `/tmp/claude-sandbox-git-${Date.now()}.tar`;
    // Exclude macOS resource fork files and .DS_Store when creating git archive
    // Also strip extended attributes to prevent macOS xattr issues in Docker
    const tarFlags = getTarFlags();
    // On macOS, also exclude extended attributes that cause Docker issues
    const additionalFlags = (process.platform as string) === "darwin" ? "--no-xattrs --no-fflags" : "";
    const combinedFlags = `${tarFlags} ${additionalFlags}`.trim();
    
    try {
      execSync(
        `tar -cf "${gitTarFile}" --exclude="._*" --exclude=".DS_Store" ${combinedFlags} .git`,
        {
          cwd: workDir,
          stdio: "pipe",
        },
      );

      const gitStream = fs.createReadStream(gitTarFile);

      // Upload git archive
      await container.putArchive(gitStream, {
        path: "/workspace",
      });

      // Clean up
      fs.unlinkSync(gitTarFile);
    } catch (error) {
      console.error(chalk.red("✗ Git history copy failed:"), error);
      // Clean up the tar file even if upload failed
      try {
        fs.unlinkSync(gitTarFile);
      } catch (e) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  private async setupStartupScriptOnly(container: Docker.Container): Promise<void> {
    console.log(chalk.blue("• Setting up startup script (non-git mode)..."));

    // Create startup script for non-git mode
    const startupScript = `#!/bin/bash
cd /workspace

# Make sure we're in a basic git repository for Claude (create minimal git setup)
if [ ! -d ".git" ]; then
  git init
  git config user.name "Claude"
  git config user.email "claude@anthropic.com"
  
  # Create initial commit if there are files
  if [ "$(ls -A . 2>/dev/null)" ]; then
    git add .
    git commit -m "Initial commit" --allow-empty
  fi
fi

# Start Claude Code with configured options
exec claude --dangerously-skip-permissions
`;

    // Write startup script to container
    const exec = await container.exec({
      Cmd: [
        "bash",
        "-c",
        `cat > /home/claude/start-session.sh << 'EOF'
${startupScript}
EOF`,
      ],
      AttachStdout: true,
      AttachStderr: true,
    });

    await exec.start({ hijack: false });

    // Make script executable
    const chmodExec = await container.exec({
      Cmd: ["chmod", "+x", "/home/claude/start-session.sh"],
      AttachStdout: true,
      AttachStderr: true,
    });

    await chmodExec.start({ hijack: false });
    
    console.log(chalk.green("✓ Startup script created"));
  }

  private async _copyClaudeConfig(container: Docker.Container): Promise<void> {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { execSync } = require("child_process");

    // Helper function to get tar flags safely
    const getTarFlags = () => {
      try {
        // Test if --no-xattrs is supported by checking tar help
        execSync("tar --help 2>&1 | grep -q no-xattrs", { stdio: "pipe" });
        return "--no-xattrs";
      } catch {
        // --no-xattrs not supported, use standard tar
        return "";
      }
    };

    try {
      // First, try to get credentials from macOS Keychain if on Mac
      if (process.platform === "darwin") {
        try {
          console.log(
            chalk.blue("• Checking macOS Keychain for Claude credentials..."),
          );
          const keychainCreds = execSync(
            'security find-generic-password -s "Claude Code-credentials" -w',
            {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"], // Suppress stderr
            },
          ).trim();

          if (keychainCreds) {
            console.log(
              chalk.green("✓ Found Claude credentials in macOS Keychain"),
            );

            // Create .claude directory structure
            const claudeDirTar = `/tmp/claude-keychain-${Date.now()}.tar`;
            const tarStream = require("tar-stream");
            const pack = tarStream.pack();

            // Add .credentials.json to the tar
            pack.entry(
              { name: ".claude/.credentials.json", mode: 0o600 },
              keychainCreds,
              (err: any) => {
                if (err) throw err;
                pack.finalize();
              },
            );

            const chunks: Buffer[] = [];
            pack.on("data", (chunk: any) => chunks.push(chunk));

            await new Promise<void>((resolve, reject) => {
              pack.on("end", () => {
                fs.writeFileSync(claudeDirTar, Buffer.concat(chunks));
                resolve();
              });
              pack.on("error", reject);
            });

            const stream = fs.createReadStream(claudeDirTar);
            await container.putArchive(stream, {
              path: "/home/claude",
            });

            fs.unlinkSync(claudeDirTar);

            // Fix permissions
            await container
              .exec({
                Cmd: [
                  "/bin/bash",
                  "-c",
                  "sudo mkdir -p /home/claude/.claude && sudo chown -R claude:claude /home/claude/.claude && sudo chmod 700 /home/claude/.claude && sudo chmod 600 /home/claude/.claude/.credentials.json",
                ],
                AttachStdout: false,
                AttachStderr: false,
              })
              .then((exec) => exec.start({}));

            console.log(
              chalk.green("✓ Claude Keychain credentials copied to container"),
            );
          }
        } catch (error) {
          // Keychain access failed or credentials not found - not critical
          console.log(
            chalk.yellow("• No Claude credentials found in macOS Keychain"),
          );
        }
      }

      // Copy .claude.json if it exists
      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      if (fs.existsSync(claudeJsonPath)) {
        console.log(chalk.blue("• Copying .claude.json..."));

        const configContent = fs.readFileSync(claudeJsonPath, "utf-8");
        const tarFile = `/tmp/claude-json-${Date.now()}.tar`;
        const tarStream = require("tar-stream");
        const pack = tarStream.pack();

        pack.entry(
          { name: ".claude.json", mode: 0o644 },
          configContent,
          (err: any) => {
            if (err) throw err;
            pack.finalize();
          },
        );

        const chunks: Buffer[] = [];
        pack.on("data", (chunk: any) => chunks.push(chunk));

        await new Promise<void>((resolve, reject) => {
          pack.on("end", () => {
            fs.writeFileSync(tarFile, Buffer.concat(chunks));
            resolve();
          });
          pack.on("error", reject);
        });

        const stream = fs.createReadStream(tarFile);
        await container.putArchive(stream, {
          path: "/home/claude",
        });

        fs.unlinkSync(tarFile);

        // Fix permissions
        await container
          .exec({
            Cmd: [
              "/bin/bash",
              "-c",
              "sudo chown claude:claude /home/claude/.claude.json && chmod 644 /home/claude/.claude.json",
            ],
            AttachStdout: false,
            AttachStderr: false,
          })
          .then((exec) => exec.start({}));
      }

      // Copy .claude directory if it exists (but skip if we already copied from Keychain)
      const claudeDir = path.join(os.homedir(), ".claude");
      if (
        fs.existsSync(claudeDir) &&
        fs.statSync(claudeDir).isDirectory() &&
        process.platform !== "darwin"
      ) {
        console.log(chalk.blue("• Copying .claude directory..."));

        const tarFile = `/tmp/claude-dir-${Date.now()}.tar`;
        const tarFlags = getTarFlags();
        // On macOS, also exclude extended attributes that cause Docker issues
        const additionalFlags = (process.platform as string) === "darwin" ? "--no-xattrs --no-fflags" : "";
        const combinedFlags = `${tarFlags} ${additionalFlags}`.trim();
        execSync(
          `tar -cf "${tarFile}" ${combinedFlags} -C "${os.homedir()}" .claude`,
          {
            stdio: "pipe",
          },
        );

        const stream = fs.createReadStream(tarFile);
        await container.putArchive(stream, {
          path: "/home/claude",
        });

        fs.unlinkSync(tarFile);

        // Fix permissions recursively
        await container
          .exec({
            Cmd: [
              "/bin/bash",
              "-c",
              "sudo chown -R claude:claude /home/claude/.claude && chmod -R 755 /home/claude/.claude",
            ],
            AttachStdout: false,
            AttachStderr: false,
          })
          .then((exec) => exec.start({}));
      }

      console.log(chalk.green("✓ Claude configuration copied successfully"));
    } catch (error) {
      console.error(
        chalk.yellow("⚠ Failed to copy Claude configuration:"),
        error,
      );
      // Don't throw - this is not critical for container operation
    }
  }

  private async _copyGitConfig(container: Docker.Container): Promise<void> {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const gitConfigPath = path.join(os.homedir(), ".gitconfig");

    try {
      // Check if the git config file exists
      if (!fs.existsSync(gitConfigPath)) {
        return; // No git config to copy
      }

      console.log(chalk.blue("• Copying git configuration..."));

      // Read the git config file
      const configContent = fs.readFileSync(gitConfigPath, "utf-8");

      // Create a temporary tar file with the git config
      const tarFile = `/tmp/git-config-${Date.now()}.tar`;
      const tarStream = require("tar-stream");
      const pack = tarStream.pack();

      // Add the .gitconfig file to the tar
      pack.entry(
        { name: ".gitconfig", mode: 0o644 },
        configContent,
        (err: any) => {
          if (err) throw err;
          pack.finalize();
        },
      );

      // Write the tar to a file
      const chunks: Buffer[] = [];
      pack.on("data", (chunk: any) => chunks.push(chunk));

      await new Promise<void>((resolve, reject) => {
        pack.on("end", () => {
          fs.writeFileSync(tarFile, Buffer.concat(chunks));
          resolve();
        });
        pack.on("error", reject);
      });

      // Copy the tar file to the container's claude user home directory
      const stream = fs.createReadStream(tarFile);
      await container.putArchive(stream, {
        path: "/home/claude", // Copy to claude user's home directory
      });

      // Clean up
      fs.unlinkSync(tarFile);

      // Fix permissions on the copied file
      const fixPermsExec = await container.exec({
        Cmd: [
          "/bin/bash",
          "-c",
          "sudo chown claude:claude /home/claude/.gitconfig",
        ],
        AttachStdout: false,
        AttachStderr: false,
      });

      await fixPermsExec.start({});

      console.log(chalk.green("✓ Git configuration copied successfully"));
    } catch (error) {
      console.error(
        chalk.yellow("⚠ Failed to copy git configuration:"),
        error,
      );
      // Don't throw - this is not critical for container operation
    }
  }

  private async setupGitAndStartupScript(
    container: any,
    branchName: string,
    prFetchRef?: string,
    remoteFetchRef?: string,
  ): Promise<void> {
    console.log(chalk.blue("• Setting up git branch and startup script..."));

    // Determine what to show in the web UI
    const defaultShell = this.config.defaultShell || "claude";

    // Startup script that keeps session alive
    const startupScript =
      defaultShell === "claude"
        ? `#!/bin/bash
echo "🚀 Starting Claude Code..."
echo "Press Ctrl+C to drop to bash shell"
echo ""

# Run Claude but don't replace the shell process
claude --dangerously-skip-permissions

# After Claude exits, drop to bash
echo ""
echo "Claude exited. You're now in bash shell."
echo "Type 'claude --dangerously-skip-permissions' to restart Claude"
echo "Type 'exit' to end the session"
echo ""
exec /bin/bash`
        : `#!/bin/bash
echo "Welcome to Claude Code Sandbox!"
echo "Type 'claude --dangerously-skip-permissions' to start Claude Code"
echo "Type 'exit' to end the session"
echo ""
exec /bin/bash`;

    const setupExec = await container.exec({
      Cmd: [
        "/bin/bash",
        "-c",
        `
        cd /workspace &&
        sudo chown -R claude:claude /workspace &&
        git config --global --add safe.directory /workspace &&
        # Clean up macOS resource fork files in git pack directory
        find .git/objects/pack -name "._pack-*.idx" -type f -delete 2>/dev/null || true &&
        # Configure git to use GitHub token if available
        if [ -n "$GITHUB_TOKEN" ]; then
          git config --global url."https://\${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
          git config --global url."https://\${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
          echo "✓ Configured git to use GitHub token"
        fi &&
        # Handle different branch setup scenarios
        if [ -n "${prFetchRef || ""}" ]; then
          echo "• Fetching PR branch..." &&
          git fetch origin ${prFetchRef} &&
          if git show-ref --verify --quiet refs/heads/"${branchName}"; then
            git checkout "${branchName}" &&
            echo "✓ Switched to existing PR branch: ${branchName}"
          else
            git checkout "${branchName}" &&
            echo "✓ Checked out PR branch: ${branchName}"
          fi
        elif [ -n "${remoteFetchRef || ""}" ]; then
          echo "• Fetching remote branch..." &&
          git fetch origin &&
          if git show-ref --verify --quiet refs/heads/"${branchName}"; then
            git checkout "${branchName}" &&
            git pull origin "${branchName}" &&
            echo "✓ Switched to existing remote branch: ${branchName}"
          else
            git checkout -b "${branchName}" "${remoteFetchRef}" &&
            echo "✓ Created local branch from remote: ${branchName}"
          fi
        else
          # Regular branch creation
          if git show-ref --verify --quiet refs/heads/"${branchName}"; then
            git checkout "${branchName}" &&
            echo "✓ Switched to existing branch: ${branchName}"
          else
            git checkout -b "${branchName}" &&
            echo "✓ Created new branch: ${branchName}"
          fi
        fi &&
        cat > /home/claude/start-session.sh << 'EOF'
${startupScript}
EOF
        chmod +x /home/claude/start-session.sh &&
        echo "✓ Startup script created"
      `,
      ],
      AttachStdout: true,
      AttachStderr: true,
    });

    const setupStream = await setupExec.start({});

    // Wait for setup to complete
    await new Promise<void>((resolve, reject) => {
      let output = "";
      setupStream.on("data", (chunk: any) => {
        output += chunk.toString();
        process.stdout.write(chunk);
      });
      setupStream.on("end", () => {
        if (
          (output.includes("✓ Created new branch") ||
            output.includes("✓ Switched to existing branch") ||
            output.includes("✓ Switched to existing remote branch") ||
            output.includes("✓ Switched to existing PR branch") ||
            output.includes("✓ Checked out PR branch") ||
            output.includes("✓ Created local branch from remote")) &&
          output.includes("✓ Startup script created")
        ) {
          resolve();
        } else {
          reject(new Error("Setup failed"));
        }
      });
      setupStream.on("error", reject);
    });

    console.log(chalk.green("✓ Git and startup script setup completed"));
  }

  private async runSetupCommands(container: any): Promise<void> {
    // Execute custom setup commands if provided
    if (this.config.setupCommands && this.config.setupCommands.length > 0) {
      console.log(chalk.blue("• Running custom setup commands..."));
      console.log(
        chalk.blue(
          `  Total commands to run: ${this.config.setupCommands.length}`,
        ),
      );

      for (let i = 0; i < this.config.setupCommands.length; i++) {
        const command = this.config.setupCommands[i];
        console.log(
          chalk.yellow(
            `\n[${i + 1}/${this.config.setupCommands.length}] Running command:`,
          ),
        );
        console.log(chalk.white(`  ${command}`));

        const cmdExec = await container.exec({
          Cmd: ["/bin/bash", "-c", command],
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: "/workspace",
          User: "claude",
        });

        const cmdStream = await cmdExec.start({});

        // Wait for command to complete
        await new Promise<void>((resolve, reject) => {
          let hasError = false;

          cmdStream.on("data", (chunk: any) => {
            process.stdout.write("  > " + chunk.toString());
          });

          cmdStream.on("end", async () => {
            // Check exit code
            try {
              const info = await cmdExec.inspect();
              if (info.ExitCode !== 0) {
                console.error(
                  chalk.red(`✗ Command failed with exit code ${info.ExitCode}`),
                );
                hasError = true;
              } else {
                console.log(chalk.green(`✓ Command completed successfully`));
              }
            } catch (e) {
              // Ignore inspection errors
            }

            if (hasError && this.config.setupCommands?.includes("set -e")) {
              reject(new Error(`Setup command failed: ${command}`));
            } else {
              resolve();
            }
          });

          cmdStream.on("error", reject);
        });
      }

      console.log(chalk.green("✓ All setup commands completed"));
    }
  }

  async cleanup(): Promise<void> {
    for (const [, container] of this.containers) {
      try {
        await container.stop();
        await container.remove();
      } catch (error) {
        // Container might already be stopped
      }
    }
    this.containers.clear();
  }
}
