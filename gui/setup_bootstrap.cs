using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

static class SetupBootstrap
{
    [STAThread]
    static int Main(string[] args)
    {
        string working = null;
        try
        {
            working = Unpack();
            var start = new ProcessStartInfo(Path.Combine(working, "BrowserControlInstaller.exe"));
            start.UseShellExecute = false;
            start.WorkingDirectory = working;
            start.EnvironmentVariables["BROWSER_CONTROL_SETUP_PATH"] = Assembly.GetExecutingAssembly().Location;
            start.EnvironmentVariables.Remove("BROWSER_CONTROL_SETUP_RESUME");
            if (args.Length == 2 && args[0] == "--resume-install")
                start.EnvironmentVariables["BROWSER_CONTROL_SETUP_RESUME"] = args[1];
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Browser Control 安装无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            if (!Clean(working))
                MessageBox.Show("Windows 未能清理安装器的暂存目录。\n\n" + working,
                    "Browser Control 安装", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static string Unpack()
    {
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var locations = new[] {
            Environment.GetEnvironmentVariable("TMP"),
            Environment.GetEnvironmentVariable("TEMP"),
            String.IsNullOrEmpty(appData) ? null : Path.Combine(appData, "Temp"),
            AppDomain.CurrentDomain.BaseDirectory
        };
        var attempted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string location in locations)
        {
            if (String.IsNullOrWhiteSpace(location)) continue;
            string working = null;
            try
            {
                string parent = Path.GetFullPath(location);
                if (!attempted.Add(parent)) continue;
                string candidate = Path.Combine(parent, "BrowserControlSetup-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(candidate);
                working = candidate;
                File.SetAttributes(working, File.GetAttributes(working) | FileAttributes.Hidden);
                Extract(working);
                return working;
            }
            catch (Exception error)
            {
                if (!Clean(working))
                    throw new IOException("Windows 未能清理解包失败后的暂存目录。\n\n" + working, error);
                if (error is InvalidDataException ||
                    !(error is UnauthorizedAccessException || error is IOException ||
                      error is ArgumentException || error is NotSupportedException)) throw;
            }
        }
        throw new IOException("无法解包安装程序。请检查是否有足够的磁盘空间，或将安装包复制到可写文件夹后再运行。");
    }

    static void Extract(string directory)
    {
        string prefix = directory + Path.DirectorySeparatorChar;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("setup.zip"))
        {
            if (stream == null) throw new InvalidDataException("安装包缺少内嵌文件，请重新下载。");
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (var entry in archive.Entries)
                {
                    string file = Path.GetFullPath(Path.Combine(directory, entry.FullName));
                    if (!file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("安装包内的文件路径无效，请重新下载。");
                    if (entry.Name.Length == 0)
                    {
                        Directory.CreateDirectory(file);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    using (var source = entry.Open())
                    using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        source.CopyTo(output);
                }
            }
        }
    }

    static bool Clean(string directory)
    {
        if (directory == null) return true;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) return false;
                Directory.Delete(directory, true);
                return true;
            }
            catch (DirectoryNotFoundException) { return true; }
            catch (FileNotFoundException) { if (!Directory.Exists(directory)) return true; }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            if (attempt < 2) Thread.Sleep(200);
        }
        return false;
    }
}
