# Video Client Library
This library provides a user friendly integration for consuming real time video streams. It allows to send back AI analytics results and receive video streams with low latency.
The library is built using **Rust** language and provides C bindings for easy integration with third party applications.<br>
The Library automatically connects to a streaming video(over TCP), and allows sending AI analytics directly to the backend.

## Building the Library
To build the library, ensure you have the necessary dependencies installed. You can then run the following command in the terminal:
```bash
# Install dependencies on Fedora-based systems
dnf install -y \
  perl-FindBin
  clang \
  clang-devel \
  llvm-devel \
  gcc \
  gcc-c++ \
  make \
  cmake \
  git \
  autoconf \
  automake \
  libtool \
  pkgconfig \
  perl \
  python3 \
  diffutils \
  gettext \
  wget

# Build dependencies required to build the library
./build_dependencies.sh
```

After building the dependencies(Done only once), you can build the library by running the following command:
```bash
./build_library.sh
``` 
