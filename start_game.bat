@echo off
echo 正在启动拯救赵老师游戏...
echo.
echo 请注意：
echo 1. HTTP服务器正在启动...
echo 2. 请在浏览器中访问 http://localhost:8009
echo 3. 不要直接双击HTML文件！
echo.

start "Game Server" cmd /k "python -m http.server 8009"
timeout /t 3 /nobreak > nul
start http://localhost:8009

echo 游戏已启动！
echo 如果浏览器没有自动打开，请手动访问：http://localhost:8009
pause 