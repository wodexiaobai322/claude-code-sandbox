export interface VolumeMount {
  source: string;
  target: string;
  readonly?: boolean;
}

export interface SandboxConfig {
  dockerImage?: string;
  dockerfile?: string;
  containerPrefix?: string;
  customContainerName?: boolean; // Flag to indicate if container name was explicitly provided by user
  autoPush?: boolean;
  autoCreatePR?: boolean;
  autoStartClaude?: boolean;
  defaultShell?: "claude" | "bash";
  claudeConfigPath?: string;
  setupCommands?: string[];
  environment?: Record<string, string>;
  envFile?: string;
  volumes?: string[];
  mounts?: VolumeMount[];
  allowedTools?: string[];
  maxThinkingTokens?: number;
  bashTimeout?: number;
  includeUntracked?: boolean;
  targetBranch?: string;
  remoteBranch?: string;
  prNumber?: string;
  dockerSocketPath?: string;
  webUI?: boolean;
  noGit?: boolean; // Disable git functionality
  // 新增：工作目录相关配置
  workingDirectory?: string;  // 指定工作目录路径
  autoCreateWorkDir?: boolean; // 是否自动创建工作目录
  workDirTemplate?: string;   // 工作目录模板（如output/projects/ProjectName_timestamp）
}

export interface Credentials {
  claude?: {
    type: "api_key" | "oauth" | "bedrock" | "vertex";
    value: string;
    region?: string;
    project?: string;
  };
  github?: {
    token?: string;
    gitConfig?: string;
  };
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: string[];
}
