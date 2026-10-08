# The JNI bridge that starts Node (nodejs-mobile) inside the app, after the
# nodejs-mobile-samples android/native-gradle sample. libnode.so and its headers
# are staged in app/libnode by android/fetch-libnode.sh.
cmake_minimum_required(VERSION 3.22.1)
project(argus_native LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LIBNODE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode)
set(LIBNODE_SO ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

if(NOT EXISTS ${LIBNODE_SO})
  message(FATAL_ERROR "missing ${LIBNODE_SO}: run android/fetch-libnode.sh first")
endif()
if(NOT EXISTS ${LIBNODE_DIR}/include/node/node.h)
  message(FATAL_ERROR "missing ${LIBNODE_DIR}/include/node/node.h: run android/fetch-libnode.sh first")
endif()

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${LIBNODE_DIR}/include/node)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_SO})

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
