#pragma once

namespace lb {

// Windows 콘솔이 UTF-8 한글 출력을 깨뜨리지 않게 한다. 다른 플랫폼에서는 아무것도 하지 않는다.
void enableUtf8Console();

}  // namespace lb
