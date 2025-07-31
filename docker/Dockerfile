FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set locale to support Chinese characters
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Install system dependencies including Chinese language support
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    python3 \
    python3-pip \
    build-essential \
    sudo \
    vim \
    ca-certificates \
    gnupg \
    locales \
    language-pack-zh-hans \
    && rm -rf /var/lib/apt/lists/*

# Generate UTF-8 locale
RUN locale-gen en_US.UTF-8 zh_CN.UTF-8 && \
    update-locale LANG=C.UTF-8

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# Skip GitHub CLI installation to avoid slow network requests

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code@latest

# Create a non-root user with sudo privileges
RUN useradd -m -s /bin/bash claude && \
    echo 'claude ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    usermod -aG sudo claude

# Create workspace directory and set ownership
RUN mkdir -p /workspace && \
    chown -R claude:claude /workspace

# Switch to non-root user
USER claude
WORKDIR /workspace

# Set up entrypoint
ENTRYPOINT ["/bin/bash", "-c"]